export type L10nArg = string | number | boolean;
export type Translator = (message: string, ...args: L10nArg[]) => string;

function format(message: string, ...args: L10nArg[]): string {
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const arg = args[Number(index)];
    return arg === undefined ? placeholder : String(arg);
  });
}

let translator: Translator = format;

export function setTranslator(next: Translator = format): void {
  translator = next;
}

// Call at render time, never at module load: the translator is set during activation.
export function t(message: string, ...args: L10nArg[]): string {
  return translator(message, ...args);
}
