import { debounce } from 'lodash';
import { spawn } from 'node:child_process';
import {
  CancellationTokenSource,
  ConfigurationChangeEvent,
  Diagnostic,
  DiagnosticCollection,
  DiagnosticSeverity,
  Disposable,
  Range,
  TextDocument,
  TextDocumentChangeEvent,
  Uri,
  languages,
  window,
  workspace,
} from 'vscode';
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
  logger.info(
    `SNIFFER COMMAND: ${resourceConf.executablePathCS} ${lintArgs.join(' ')}`,
  );

  const sniffer = spawn(resourceConf.executablePathCS, lintArgs, options);

  sniffer.stdin.write(fileText);
  sniffer.stdin.end();

  let stdout = '';
  let stderr = '';

  sniffer.stdout.on('data', (data) => (stdout += data));
  sniffer.stderr.on('data', (data) => (stderr += data));

  const done = new Promise<void>((resolve, reject) => {
    sniffer.on('close', () => {
      if (token.isCancellationRequested || !stdout) {
        resolve();
        return;
      }
      const diagnostics: Diagnostic[] = [];
      try {
        const { files }: PHPCSReport = JSON.parse(stdout);
        for (const file in files) {
          files[file].messages.forEach(
            ({ message, line, column, type, source }) => {
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
              const diagnostic = new Diagnostic(range, output, severity);
              diagnostic.source = 'phpcs';
              diagnostics.push(diagnostic);
            },
          );
        }
        resolve();
      } catch (error) {
        let message = '';
        if (stdout) {
          message += `${stdout}\n`;
        }
        if (stderr) {
          message += `${stderr}\n`;
        }
        if (error instanceof Error) {
          message += error.toString();
        } else {
          message += 'Unexpected error';
        }
        window.showErrorMessage(message);
        logger.error(message);
        reject(message);
      }
      diagnosticCollection.set(document.uri, diagnostics);
      runner.dispose();
      runnerCancellations.delete(document.uri);
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
