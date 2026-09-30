import type { ClientCommand, UIThinkingLevel } from "./protocol.ts";

/** Transport must reject frames above this budget before parsing JSON. */
export const CLIENT_COMMAND_MAX_BYTES = 64 * 1024 * 1024;
export const CLIENT_COMMAND_MAX_TEXT_LENGTH = 4 * 1024 * 1024;
const MAX_IDENTIFIER_LENGTH = 4_096;
const MAX_IMAGE_DATA_LENGTH = 32 * 1024 * 1024;
const MAX_IMAGES = 64;
const MAX_ANSWERS = 256;

type InputObject = Record<string, unknown>;

function isObject(value: unknown): value is InputObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maxLength && (allowEmpty || value.length > 0);
}

function optionalString(value: unknown, maxLength: number): boolean {
  return value === undefined || isString(value, maxLength, true);
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function validImages(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_IMAGES) return false;
  let length = 0;
  for (const image of value) {
    if (!isObject(image)
      || !isString(image.data, MAX_IMAGE_DATA_LENGTH)
      || !isString(image.mimeType, 128)
      || !/^image\/[a-z0-9.+-]+$/i.test(image.mimeType)) return false;
    length += image.data.length;
    if (length > CLIENT_COMMAND_MAX_BYTES) return false;
  }
  return true;
}

function validAnswers(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isObject(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > MAX_ANSWERS) return false;
  return entries.every(([id, answers]) =>
    isString(id, MAX_IDENTIFIER_LENGTH)
    && Array.isArray(answers)
    && answers.length <= MAX_ANSWERS
    && answers.every((answer) => isString(answer, CLIENT_COMMAND_MAX_TEXT_LENGTH, true)),
  );
}

const THINKING_LEVELS: readonly UIThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const INTERACTION_ACTIONS = ["accept", "accept_for_session", "decline", "cancel", "submit"] as const;

// Record makes new protocol command variants require a validator at compile time.
const validators: Record<ClientCommand["type"], (command: InputObject) => boolean> = {
  prompt: (command) => isString(command.text, CLIENT_COMMAND_MAX_TEXT_LENGTH, true)
    && optionalString(command.requestId, MAX_IDENTIFIER_LENGTH)
    && validImages(command.images),
  get_snapshot: () => true,
  sync_events: (command) => typeof command.afterSeq === "number"
    && Number.isSafeInteger(command.afterSeq) && command.afterSeq >= 0,
  abort: () => true,
  set_model: (command) => isString(command.provider, MAX_IDENTIFIER_LENGTH)
    && isString(command.id, MAX_IDENTIFIER_LENGTH),
  set_thinking_level: (command) => typeof command.level === "string"
    && THINKING_LEVELS.includes(command.level as UIThinkingLevel),
  fork: (command) => isString(command.entryId, MAX_IDENTIFIER_LENGTH),
  get_commands: () => true,
  codex_interaction_response: (command) => {
    const response = command.response;
    return isObject(response)
      && isString(response.id, MAX_IDENTIFIER_LENGTH)
      && typeof response.action === "string"
      && INTERACTION_ACTIONS.includes(response.action as typeof INTERACTION_ACTIONS[number])
      && validAnswers(response.answers)
      && (response.scope === undefined || response.scope === "turn" || response.scope === "session");
  },
  extension_ui_response: (command) => {
    const response = command.response;
    return isObject(response)
      && isString(response.id, MAX_IDENTIFIER_LENGTH)
      && optionalBoolean(response.cancelled)
      && optionalBoolean(response.confirmed)
      && optionalString(response.value, CLIENT_COMMAND_MAX_TEXT_LENGTH);
  },
};

/**
 * Narrow parsed JSON before dispatch or error handling reads command fields.
 * Unknown fields and MCP form content remain intact: they belong to the runtime
 * interaction schema, while the transport enforces the overall frame budget.
 */
export function parseClientCommand(value: unknown): ClientCommand | null {
  if (!isObject(value) || typeof value.type !== "string" || !Object.hasOwn(validators, value.type)) return null;
  const validate = validators[value.type as ClientCommand["type"]];
  return validate(value) ? value as unknown as ClientCommand : null;
}

/** Correlate a rejected prompt without trusting its remaining command fields. */
export function boundedPromptRequestId(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  try {
    // Parsed JSON has own data properties. Do not read inherited fields or call
    // getters if another caller passes an arbitrary object to this helper.
    const type = Object.getOwnPropertyDescriptor(value, "type")?.value;
    const requestId: unknown = Object.getOwnPropertyDescriptor(value, "requestId")?.value;
    return type === "prompt" && isString(requestId, MAX_IDENTIFIER_LENGTH) ? requestId : undefined;
  } catch {
    return undefined;
  }
}

/** Validate and enforce the UTF-8 frame budget before queuing a client command. */
export function serializeClientCommand(value: unknown): string | null {
  try {
    const command = parseClientCommand(value);
    if (!command) return null;
    const serialized = JSON.stringify(command);
    return typeof serialized === "string" && new TextEncoder().encode(serialized).byteLength <= CLIENT_COMMAND_MAX_BYTES
      ? serialized
      : null;
  } catch {
    return null;
  }
}
