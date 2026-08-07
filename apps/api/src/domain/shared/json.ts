export type JsonPrimitive =
  | string
  | number
  | boolean
  | null
  | undefined
  | unknown;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];
