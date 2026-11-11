// Translation seam for user-facing strings. The English text is the key, as in vscode.l10n.
// Modules that build text (limitsReader, burnRate, ...) are unit-tested under plain node and
// must not import 'vscode', so the extension injects vscode.l10n.t on activation instead.
// Until then - and in tests - strings come back in English with placeholders filled in.

export type L10nArg = string | number | boolean;
export type Translator = (message: string, ...args: L10nArg[]) => string;

function format(message: string, ...args: L10nArg[]): string {
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const arg = args[Number(index)];
    return arg === undefined ? placeholder : String(arg);
  });
}

let translator: Translator = format;

// Pass nothing to go back to plain English.
export function setTranslator(next: Translator = format): void {
  translator = next;
}

// Call at render time, never at module load: the translator is set during activation.
export function t(message: string, ...args: L10nArg[]): string {
  return translator(message, ...args);
}
