import spawn from 'cross-spawn';
import { debounce } from 'lodash';
import { SpawnSyncOptions } from 'node:child_process';
import {
  CancellationTokenSource,
  ConfigurationChangeEvent,
  Diagnostic,
  DiagnosticCollection,
  DiagnosticSeverity,
  Disposable,
  languages,
  Range,
  TextDocument,
  TextDocumentChangeEvent,
  Uri,
  window,
  workspace,
} from 'vscode';
import {
  getErrorMsg,
  getMappedExitCode,
  getStandardDisabledErrorMsg,
  isStandardDisabled,
} from './errors';
import { PHPCSMessageType, PHPCSReport } from './interfaces/phpcs-report';
import { Settings } from './interfaces/settings';
import { logger } from './logger';
import { createStandardsPathResolver } from './resolvers/standards-path-resolver';
import { loadSettings } from './settings';

const enum runConfig {
  save = 'onSave',
  type = 'onType',
}

let settingsCache: Settings;
const diagnosticCollection: DiagnosticCollection =
  languages.createDiagnosticCollection('php');

/**
 * The active validator listener.
 */
let validatorListener: Disposable;

/**
 * Token to cancel a current validation runs.
 */
const runnerCancellations: Map<Uri, CancellationTokenSource> = new Map();

const getSettings = async () => {
  if (!settingsCache) {
    settingsCache = await loadSettings();
  }
  return settingsCache;
};

/**
 * Build the arguments needed to execute sniffer
 * @param fileName
 * @param standard
 */
const getArgs = (
  document: TextDocument,
  standard: string,
  additionalArguments: string[],
) => {
  // Process linting paths.
  let filePath = document.fileName;

  let args = [];
  args.push('--report=json');
  args.push('-q');

  /**
   * Important Note as explained in PR #155:
   *
   * For the sniffer to work properly, we add `shell: true` to spawn's options.
   * This is important because when spawn runs on Windows with `shell: true`, it won't automatically
   * escape the command and values, instead it just passes it straight to the shell as is.
   *
   * So we need to add double quotes around the values for the `--standard` and `--stdin-path`
   * options, otherwise when there's spaces in the values it will break the command and errors will
   * occur (as documented in issues #136 and #144).
   *
   * The fixer is different, it doesn't need to be surrounded by double quotes.
   *
   * EDIT: 22/08/25 Node v22.18.0, npm v11.5.2 :
   * Apparently spawn now needs `shell: true` to be set on fixer (and surround values in quotes).
   */

  if (standard !== '') {
    args.push(`--standard="${standard}"`);
  }
  args.push(`--stdin-path="${filePath}"`);
  args.push('-');
  args = args.concat(additionalArguments);
  return args;
};

/**
 * Lints a document.
 *
 * @param document - The document to lint.
 */
const validate = async (document: TextDocument) => {
  const workspaceFolder = workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    return;
  }
  const settings = await getSettings();
  const resourceConf = settings.resources[workspaceFolder.index];
  if (document.languageId !== 'php' || resourceConf.snifferEnable === false) {
    return;
  }
  logger.startTimer('Sniffer');

  const additionalArguments = resourceConf.snifferArguments.filter((arg) => {
    if (
      arg.indexOf('--report') === -1 &&
      arg.indexOf('--standard') === -1 &&
      arg.indexOf('--stdin-path') === -1 &&
      arg !== '-q' &&
      arg !== '-'
    ) {
      return true;
    }

    return false;
  });

  const oldRunner = runnerCancellations.get(document.uri);
  if (oldRunner) {
    oldRunner.cancel();
    oldRunner.dispose();
  }

  const runner = new CancellationTokenSource();
  runnerCancellations.set(document.uri, runner);
  const { token } = runner;

  const standard = await createStandardsPathResolver(
    document,
    resourceConf,
  ).resolve();
  const lintArgs = getArgs(document, standard, additionalArguments);

  let fileText = document.getText();

  const options = {
    cwd:
      resourceConf.workspaceRoot !== null
        ? resourceConf.workspaceRoot
        : undefined,
    env: process.env,
    encoding: 'utf8',
    tty: true,
    shell: true,
  };

  const executablePathCS = `"${resourceConf.executablePathCS}"`;

  logger.info(`SNIFFER COMMAND: ${executablePathCS} ${lintArgs.join(' ')}`);

  const sniffer = spawn(executablePathCS, lintArgs, options);

  sniffer.stdin.write(fileText);
  sniffer.stdin.end();

  let stdout = '';
  let stderr = '';

  sniffer.stdout.on('data', (data) => (stdout += data));
  sniffer.stderr.on('data', (data) => (stderr += data));

  const done = new Promise<void>((resolve, reject) => {
    sniffer.on('close', (code) => {
      // Log the sniffer status code and message.
      // Has to be in a Promise `then` callback function to resolve the promise to a value.
      // Can't use async/await here.
      getMappedExitCode(code, 'sniffer').then((mappedCode) => {
        const errorMsg = getErrorMsg(mappedCode, 'sniffer');

        logger.info(`SNIFFER STATUS: ${mappedCode} - ${errorMsg}`);
      });

      if (token.isCancellationRequested || !stdout) {
        if (isStandardDisabled(standard, 'phpcs', stdout, stderr)) {
          const message = getStandardDisabledErrorMsg(
            standard,
            'phpcs',
            stdout,
            stderr,
          );
          logger.info(`SNIFFER: ${message}`);
          window.showErrorMessage(message);
        }
        resolve();
        return;
      }
      const diagnostics: Diagnostic[] = [];
      try {
        const { files }: PHPCSReport = JSON.parse(stdout);
        for (const file in files) {
          files[file].messages.forEach(
            ({ message, line, column, type, source, fixable }) => {
              const zeroLine = line - 1;
              const ZeroColumn = column - 1;

              const range = new Range(
                zeroLine,
                ZeroColumn,
                zeroLine,
                ZeroColumn,
              );
              const severity =
                type === PHPCSMessageType.ERROR
                  ? DiagnosticSeverity.Error
                  : DiagnosticSeverity.Warning;
              let output = message;
              if (settings.snifferShowSources) {
                output += `\n(${source})`;
              }
              output += `\nAuto-fixable: ${fixable ? '✔️' : '❌'}`;
              const diagnostic = new Diagnostic(range, output, severity);
              diagnostic.source = 'phpcs';
              diagnostics.push(diagnostic);
            },
          );
        }
        resolve();
      } catch (error) {
        let message = '';
        const errorString = error.toString();

        if (stdout) {
          message += `${stdout}\n`;
        }
        if (stderr) {
          message += `${stderr}\n`;
        }
        if (error instanceof Error) {
          message += errorString;
        } else {
          message += 'Unexpected error';
        }

        if (isStandardDisabled(standard, 'phpcs', stdout, stderr)) {
          message = getStandardDisabledErrorMsg(
            standard,
            'phpcs',
            stdout,
            stderr,
          );
        }

        window.showErrorMessage(message);
        logger.error(message, error);
        reject(message);
      }
      diagnosticCollection.set(document.uri, diagnostics);
      runner.dispose();
      runnerCancellations.delete(document.uri);
    });

    sniffer.on('error', (error) => {
      logger.error(`SNIFFER ERROR: ${error}`);
    });
  });

  window.setStatusBarMessage('PHP Sniffer: validating…', done);
  logger.endTimer('Sniffer');
};

/**
 * Refreshes validation on any open documents.
 */
const refresh = (): void => {
  diagnosticCollection!.clear();

  workspace.textDocuments.forEach(validate);
};

/**
 * Clears diagnostics from a document.
 *
 * @param document - The document to clear diagnostics of.
 */
const clearDocumentDiagnostics = ({ uri }: TextDocument): void => {
  diagnosticCollection.delete(uri);
};

/**
 * Sets the validation event listening.
 */
const setValidatorListener = async (): Promise<void> => {
  if (validatorListener) {
    validatorListener.dispose();
  }
  const settings = await getSettings();
  const run: runConfig = settings.snifferMode as runConfig;
  const delay: number = settings.snifferTypeDelay;

  if (run === (runConfig.type as string)) {
    const validator = debounce(
      ({ document }: TextDocumentChangeEvent): void => {
        validate(document);
      },
      delay,
    );
    validatorListener = workspace.onDidChangeTextDocument(validator);
  } else {
    validatorListener = workspace.onDidSaveTextDocument(validate);
  }
};

/**
 * Reacts on configuration change.
 *
 * @param event - The configuration change event.
 */
const onConfigChange = async (event: ConfigurationChangeEvent) => {
  if (!event.affectsConfiguration('phpsab')) {
    return;
  }
  settingsCache = await loadSettings();

  if (
    event.affectsConfiguration('phpsab.snifferMode') ||
    event.affectsConfiguration('phpsab.snifferTypeDelay')
  ) {
    setValidatorListener();
  }

  refresh();
};

/**
 * Dispose this object.
 */
export const disposeSniffer = (): void => {
  diagnosticCollection.clear();
  diagnosticCollection.dispose();
};

export const activateSniffer = async (
  subscriptions: Disposable[],
  settings: Settings,
) => {
  settingsCache = settings;
  if (
    settings.resources.filter((folder) => folder.snifferEnable === true)
      .length === 0
  ) {
    return;
  }
  workspace.onDidChangeConfiguration(onConfigChange, null, subscriptions);
  workspace.onDidOpenTextDocument(validate, null, subscriptions);
  workspace.onDidCloseTextDocument(
    clearDocumentDiagnostics,
    null,
    subscriptions,
  );
  workspace.onDidChangeWorkspaceFolders(refresh, this, subscriptions);

  refresh();
  setValidatorListener();
};

export const snifferVersion = async () => {
  const document = window.activeTextEditor?.document;
  const workspaceFolder = workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    return;
  }
  const settings = await getSettings();
  const resourceConf = settings.resources[workspaceFolder.index];

  const options: SpawnSyncOptions = {
    cwd:
      resourceConf.workspaceRoot !== null
        ? resourceConf.workspaceRoot
        : undefined,
    env: process.env,
    encoding: 'utf8',
    shell: true,
  };

  const executablePathCS = `"${resourceConf.executablePathCS}"`;

  const version = spawn.sync(executablePathCS, ['--version'], options);
  const output = version.stdout.toString().trim();
  const semverMatch = output.match(/(\d+\.\d+\.\d+(?:-[^\s]+)?)/);
  const semver = semverMatch ? semverMatch[1] : '';

  return semver;
};
