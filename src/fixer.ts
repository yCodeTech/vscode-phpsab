import spawn from 'cross-spawn';
import { SpawnSyncOptions } from 'node:child_process';
import {
  ConfigurationChangeEvent,
  Disposable,
  Position,
  ProviderResult,
  Range,
  TextDocument,
  TextEdit,
  window,
  workspace,
} from 'vscode';
import {
  getErrorMsg,
  getMappedExitCode,
  getStandardDisabledErrorMsg,
  isStandardDisabled,
} from './errors';
import { ConsoleError } from './interfaces/console-error';
import { Settings } from './interfaces/settings';
import { logger } from './logger';
import { createStandardsPathResolver } from './resolvers/standards-path-resolver';
import { loadSettings } from './settings';

let settingsCache: Settings;

const getSettings = async () => {
  if (!settingsCache) {
    settingsCache = await loadSettings();
  }
  return settingsCache;
};

/**
 * Load Configuration from editor
 */
const reloadSettings = async (event: ConfigurationChangeEvent) => {
  if (
    !event.affectsConfiguration('phpsab') &&
    !event.affectsConfiguration('editor.formatOnSaveTimeout')
  ) {
    return;
  }
  settingsCache = await loadSettings();
};

/**
 * Build the arguments needed to execute fixer
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
  args.push('-q');

  /**
   * Important Note as explained in PR #155:
   *
   * For the fixer to work properly, we don't add `shell: true` to spawn.sync's options,
   * so spawn runs with the default of `shell: false`. This is important because when spawn runs on
   * Windows with the default it automatically escapes the command and values, including
   * surrounding them in double quotes (" ").
   *
   * So we don't need to add double quotes around the values for the `--standard` and `--stdin-path`
   * options, otherwise the values will get double the amount of quotes and errors will occur.
   *
   * e.g. ["ERROR" - 10:33:56 PM] ERROR: the ""d:\Name\projects\my project\phpcs.xml"" coding
   * standard is not installed. The installed coding standards are MySource, PEAR, PSR1, PSR2,
   * PSR12, Squiz, Zend and JPSR12.
   *
   * The sniffer is different, it needs to be surrounded by double quotes.
   *
   * EDIT: 22/08/25 Node v22.18.0, npm v11.5.2 :
   * Apparently spawn now needs `shell: true` to be set (and surround values in quotes) for the
   * command to be executed properly.
   */

  if (standard !== '') {
    args.push(`--standard="${standard}"`);
  }
  args.push(`--stdin-path="${filePath}"`);
  args = args.concat(additionalArguments);
  args.push('-');
  return args;
};

/**
 * Get the document range
 * @param document TextDocument
 * @returns Range
 */
const documentFullRange = (document: TextDocument) =>
  new Range(
    new Position(0, 0),
    document.lineAt(document.lineCount - 1).range.end,
  );

/**
 *
 * @param range Range
 * @param document TextDocument
 * @returns boolean
 */
const isFullDocumentRange = (range: Range, document: TextDocument) =>
  range.isEqual(documentFullRange(document));

/**
 * run the fixer process
 * @param document
 */
const format = async (document: TextDocument, fullDocument: boolean) => {
  const settings = await getSettings();
  const workspaceFolder = workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    return '';
  }
  const resourceConf = settings.resources[workspaceFolder.index];
  if (document.languageId !== 'php') {
    return '';
  }

  if (resourceConf.fixerEnable === false) {
    window.showInformationMessage(
      'Fixer is disable for this workspace or PHPCBF was not found for this workspace.',
    );
    return '';
  }
  logger.startTimer('Fixer');

  const additionalArguments = resourceConf.fixerArguments.filter((arg) => {
    if (
      arg.indexOf('--standard') === -1 &&
      arg.indexOf('--stdin-path') === -1 &&
      arg !== '-q' &&
      arg !== '-'
    ) {
      return true;
    }

    return false;
  });

  // setup and spawn fixer process
  const standard = await createStandardsPathResolver(
    document,
    resourceConf,
  ).resolve();

  const lintArgs = getArgs(document, standard, additionalArguments);

  let fileText = document.getText();

  const options: SpawnSyncOptions = {
    cwd:
      resourceConf.workspaceRoot !== null
        ? resourceConf.workspaceRoot
        : undefined,
    env: process.env,
    encoding: 'utf8',
    input: fileText,
    shell: true,
  };

  const executablePathCBF = `"${resourceConf.executablePathCBF}"`;

  logger.info(`FIXER COMMAND: ${executablePathCBF} ${lintArgs.join(' ')}`);

  const fixer = spawn.sync(executablePathCBF, lintArgs, options);
  const stdout = fixer.stdout.toString().trim();

  let fixed = stdout;

  let nodeErrors: { [key: string]: string } = {
    ERR_OPERATION_FAILED: 'A general script execution error occurred.',
    ENOENT: 'No such file or directory',
    ETIMEDOUT: 'Script execution timed out.',
  };

  const exitcode = await getMappedExitCode(fixer.status, 'fixer');
  const errorMsg = getErrorMsg(exitcode, 'fixer');

  logger.info(`FIXER STATUS: ${exitcode} - ${errorMsg}`);

  if (stderr) {
    logger.error(`FIXER STDERR: ${stderr}`);
  }

  let error: string = '';
  let result: string = '';
  let message: string = '';

  switch (exitcode) {
    case '-1': {
      // Status is `null`, but we have to encode it as '-1'.

      // Deal with some special case errors
      error = nodeErrors['ERR_OPERATION_FAILED'];

      if (fixer.error === undefined) {
        break;
      }
      const execError: ConsoleError = fixer.error;
      if (execError.code === 'ETIMEDOUT') {
        error = 'FIXER: Formatting the document timed out.';
      }

      if (execError.code === 'ENOENT') {
        error = `FIXER: ${execError.message}. executablePath not found.`;
      }
      break;
    }
    case 0: {
      // No fixable errors were found; OR
      // all errors were fixed successfully

      // If the file was fixed then the exit code means all errors were fixed successfully.
      if (fixed.length > 0 && fixed !== fileText) {
        result = fixed;
        message = 'All fixable errors were fixed correctly.';
      }
      // Otherwise, there were no fixable errors found.
      else {
        message = 'No fixable errors were found.';
      }

      break;
    }
    case 5: {
      // Partially fixed errors.

      if (fixed.length > 0 && fixed !== fileText) {
        result = fixed;
        message = `FIXER: ${errorMsg}`;
      }
      // Otherwise, if node internal error occurred, show the error message.
      else if (fixer.error != null) {
        error = `FIXER - Node Internal Error: ${fixer.error.message}`;
        error += '\n' + nodeErrors[fixer.error.code];
      }

      break;
    }
    default: {
      // Errors...

      if (isStandardDisabled(standard, 'phpcbf', stdout, stderr)) {
        error = getStandardDisabledErrorMsg(standard, 'phpcbf', stdout, stderr);
      }
      // Otherwise...
      else {
        // A PHPCBF error occurred.
        error = `FIXER: ${errorMsg}`;

        // If fixed output is available, append it to the error message.
        if (fixed.length > 0) {
          error += '\n' + fixed + '\n';
        }
        // Otherwise, output the standard error message from the node process.
        else if (fixer.error != null) {
          error = `FIXER - Node Internal Error: ${fixer.error.message}`;
          error += '\n' + nodeErrors[fixer.error.code];
        }
        // If no specific error is found, return a generic fatal error.
        else {
          error = 'FATAL: Unknown error occurred.';
        }
      }
    }
  }
  if (settings.debug && error === '') {
    window.showInformationMessage(message);
    logger.info(`FIXER MESSAGE: ${message}`);
  }

  logger.endTimer('Fixer');

  if (error !== '') {
    logger.error(error);
    return Promise.reject(error);
  }

  return result;
};

/**
 * Load settings and register event watcher
 * @param subscriptions Disposable array
 * @param settings Extension settings
 */
export const activateFixer = (
  subscriptions: Disposable[],
  settings: Settings,
) => {
  settingsCache = settings;
  workspace.onDidChangeConfiguration(reloadSettings, null, subscriptions);
};

/**
 * Setup wrapper to format for extension
 * @param document
 */
export const registerFixerAsDocumentProvider = (
  document: TextDocument,
  range: Range,
): ProviderResult<TextEdit[]> => {
  return new Promise((resolve, reject) => {
    const fullRange = documentFullRange(document);
    const isFullDocument = isFullDocumentRange(range, document);

    format(document, isFullDocument)
      .then((text) => {
        if (text.length > 0) {
          resolve([new TextEdit(fullRange, text)]);
        }
        throw new Error('PHPCBF returned an empty document');
      })
      .catch((err) => {
        window.showErrorMessage(err);
        reject();
      });
  });
};
