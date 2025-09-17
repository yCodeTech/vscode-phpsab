import fs from 'node:fs';
import { logger } from './logger';
import { snifferVersion } from './sniffer';

// 4.x exit codes and their messages.
/**
 * The exit codes and their messages are as follows:
 *
 * 3.x exit codes:
 * ```plain
 * 0 = PHPCS - no errors found / PHPCBF - no fixable errors were found, so nothing was fixed
 * 1 = PHPCS - errors found / PHPCBF - all fixable errors were fixed correctly
 * 2 = PHPCS - fixable errors found / PHPCBF - failed to fix some of the fixable errors it found
 * 3 = PHPCS/PHPCBF - processing error
 * ```
 *
 * 4.x exit codes:
 * ```plain
 * 0 = PHPCS - no errors were found / PHPCBF - no errors were found or all errors were fixed
 * 1 = PHPCS/PHPCBF - auto-fixable errors were found
 * 2 = PHPCS/PHPCBF - non-auto-fixable errors were found
 * 3 = PHPCS - auto-fixable and non-auto-fixable errors were found
 * 4 = PHPCBF - failed to fix some files or fixer conflict between sniffs
 * 5 = PHPCBF - failed to fix some auto-fixable errors
 * 7 = PHPCBF - failed to fix some auto-fixable errors with a mixture of non-auto-fixable
 * 16 = PHPCS/PHPCBF - processing error - like a parse error in the XML ruleset
 * ```
 * @see https://github.com/PHPCSStandards/PHP_CodeSniffer/wiki/Advanced-Usage#understanding-the-exit-codes
 * @see https://github.com/PHPCSStandards/PHP_CodeSniffer/blob/4.x/src/Util/ExitCode.php
 */
const errorMsgs: { [key: number | string]: string } = {
  // Status is `null`, but we have to encode it as '-1', only added so we can create
  // the fixerStatus mapping later.
  '-1': '',
  // The message for exit code 0 for fixer is "No errors were found or all errors were fixed"
  // The message will be updated as needed when getting the message in `getErrorMsg` function.
  0: 'No errors were found',
  1: 'Auto-fixable errors were found',
  2: 'Non-auto-fixable errors were found',
  3: 'Auto-fixable and non-auto-fixable errors were found',
  4: 'Failed to fix some files or conflict between sniffs',
  5: 'Failed to fix some auto-fixable errors',
  7: 'Failed to fix some auto-fixable errors with a mixture of non-auto-fixable',
  16: 'Processing error',
};

/**
 * Create a mapping from 4.x exit codes to their numeric values,
 * ie. use the errorMsgs keys as both keys and values.
 *
 * This is needed so that we can map the 3.x exit codes to their 4.x equivalents later.
 * So we need to create a new object with the same keys and values for 4.x to keep things simple.
 *
 * @returns exit code mapping
 */
const map4xStatusFromErrors = () => {
  return Object.fromEntries(
    Object.keys(errorMsgs).map((key) => {
      // Ensure numeric keys are returned as numbers and string keys as strings.
      const numKey = isNaN(Number(key)) ? key : Number(key);
      return [numKey, numKey];
    }),
  );
};

/**
 * Get the mapped exit code for a given code and type.
 *
 * @param code The exit code to map.
 * @param type The type of tool (either fixer or sniffer).
 * @returns The mapped exit code.
 */
export const getMappedExitCode = async (
  code: number | string | null,
  type: 'fixer' | 'sniffer',
): Promise<string | number> => {
  // Get the sniffer version string
  const snifferVersionString = await snifferVersion();

  // If code is null, set to '-1' so we can map it later.
  code ??= '-1';

  if (snifferVersionString === undefined) {
    logger.error('Unable to determine sniffer version');
    return code;
  }

  let status: { [key: number | string]: number | string } = {};

  // If sniffer version is 4.x
  if (snifferVersionString.startsWith('4.')) {
    // Create a mapping from 4.x exit codes to their numeric values.
    status = map4xStatusFromErrors();
  }
  // Otherwise, if sniffer version is 3.x
  else if (snifferVersionString.startsWith('3.')) {
    // Map 3.x exit codes to 4.x equivalent exit codes for the sniffer
    // key => value; key is the original exit code, value is the new status code
    // to use to get the message.
    status = {
      '-1': '-1', // Status is `null`, but encoded as '-1', as `null` can't be used in an array.
      0: 0,
      1: 2,
      2: 1,
      3: 16,
    };

    // If the type is 'fixer', then we need to adjust the status codes mapping accordingly.
    if (type === 'fixer') {
      status[1] = 0;
      status[2] = 5;
    }
  }

  // Return the mapped exit code or the
  // original code if not found in the mapping.
  return status[code] ?? code;
};

/**
 * Get the error message for a given status code.
 *
 * @param status The status code to get the error message for.
 * @param type The type of error (fixer or sniffer).
 *
 * @returns The error message for the given status code.
 *
 */
export const getErrorMsg = (
  status: number | string,
  type: 'fixer' | 'sniffer',
): string => {
  if (type === 'fixer') {
    // Update message for status 0 for the fixer.
    errorMsgs[0] = `No errors were found or all errors were fixed`;
  }

  return errorMsgs[status];
};

/**
 * Check if the coding standard is disabled for the specified type and
 * also has the "No sniffs were registered" error in the output.
 *
 * @param standard The path to the standard file
 * @param type The type of tool (phpcs or phpcbf)
 * @param stdout The standard output from the command
 * @param stderr The standard error output from the command
 *
 * @returns boolean Return `true` if standard is disabled for the specified type, `false` otherwise.
 */
export const isStandardDisabled = (
  standard: string,
  type: 'phpcs' | 'phpcbf',
  stdout: string,
  stderr: string,
): boolean => {
  if (!standard || standard.length === 0) {
    return false;
  }

  try {
    let isDisabled = false;

    if (fs.existsSync(standard)) {
      const standardContent: string = fs.readFileSync(standard, 'utf8');
      let attributes: string[] = [];
      // If type is phpcs...
      if (type === 'phpcs') {
        attributes = ['phpcs-only="false"', 'phpcbf-only="true"'];
      }
      // Otherwise, if type is phpcbf...
      else if (type === 'phpcbf') {
        attributes = ['phpcs-only="true"', 'phpcbf-only="false"'];
      }

      // Set isDisabled to true if any of the attributes are present in the standard content.
      if (attributes.some((attr) => standardContent.includes(attr))) {
        isDisabled = true;
      }
    }

    // If the standard is disabled for the specified type AND
    // the stdout or stderr contains the "No sniffs were registered" error,
    // then return true.
    if (isDisabled && hasNoSniffsError(stdout, stderr)) {
      return true;
    }
    // Otherwise, return false.
    return false;
  } catch (readError) {
    logger.error(`Could not read standard file: ${standard}`);
    return false;
  }
};

/**
 * Check if the stdout (3.x) OR stderr (4.x) output contains the "No sniffs were registered" error.
 * (This error in version 3.x is written to stdout, but in 4.x it's written to stderr,
 * hence the duplicate check.)
 *
 * @param stdout The standard output from the command
 * @param stderr The standard error output from the command
 *
 * @returns `true` if the error exists, `false` otherwise
 */
const hasNoSniffsError = (stdout: string, stderr: string): boolean => {
  return (
    stdout.includes('No sniffs were registered') ||
    stderr.includes('No sniffs were registered')
  );
};

/**
 * Get the error message for a disabled coding standard.
 *
 * @param standard The coding standard file path. eg. /path/phpcs.xml
 * @param type The type of tool (phpcs or phpcbf)
 * @param stdout The standard output from the command
 * @param stderr The standard error output from the command
 *
 * @returns The error message for the disabled coding standard
 */
export const getStandardDisabledErrorMsg = (
  standard: string,
  type: 'phpcs' | 'phpcbf',
  stdout: string,
  stderr: string,
): string => {
  let output = stdout || stderr;
  let typeUpperCase = type.toUpperCase();
  let otherToolUpperCase = type === 'phpcs' ? 'PHPCBF' : 'PHPCS';

  let error = `${typeUpperCase} is disabled for the coding standard ("${standard}"), and is configured to be ${otherToolUpperCase}-only. It either has the attribute 'phpcs-only' or 'phpcbf-only' set to 'true' or 'false'.\n`;

  error += `\n${typeUpperCase} `;

  // Remove the help message from the output and add the result to the error.
  error += output.replace(`\nRun "${type} --help" for usage information`, '');

  // Trim any leading/trailing whitespace from the error message, especially multiple newlines.
  error = error.trim();

  return error;
};
