/**
 * Minimal runtime validators for the IPC boundary. Every request entering the
 * main process and every response leaving it is parsed with these before it
 * crosses the renderer boundary. Object validation is strict: unknown keys are
 * rejected so a renderer cannot smuggle extra data past the contract.
 */

export class IpcValidationError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${path}: ${message}`);
    this.name = "IpcValidationError";
  }
}

export type Validator<T> = {
  parse(value: unknown, path?: string): T;
};

const optionalMarker = Symbol("optionalField");

export type OptionalValidator<T> = Validator<T> & { [optionalMarker]: true };

function fail(message: string, path: string): never {
  throw new IpcValidationError(message, path);
}

export function vString(options?: {
  nonBlank?: boolean;
  maxLength?: number;
}): Validator<string> {
  const maxLength = options?.maxLength ?? 10_000;
  return {
    parse(value, path = "value") {
      if (typeof value !== "string") fail("expected a string", path);
      if (value.length > maxLength) fail(`string exceeds ${maxLength} characters`, path);
      if (options?.nonBlank && !value.trim()) fail("string must not be blank", path);
      return value;
    },
  };
}

export function vBoolean(): Validator<boolean> {
  return {
    parse(value, path = "value") {
      if (typeof value !== "boolean") fail("expected a boolean", path);
      return value;
    },
  };
}

export function vInteger(options?: { min?: number; max?: number }): Validator<number> {
  return {
    parse(value, path = "value") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        fail("expected an integer", path);
      }
      if (options?.min !== undefined && value < options.min) {
        fail(`expected an integer >= ${options.min}`, path);
      }
      if (options?.max !== undefined && value > options.max) {
        fail(`expected an integer <= ${options.max}`, path);
      }
      return value;
    },
  };
}

export function vEnum<const T extends readonly string[]>(
  values: T,
): Validator<T[number]> {
  const allowed = new Set<string>(values);
  return {
    parse(value, path = "value") {
      if (typeof value !== "string" || !allowed.has(value)) {
        fail(`expected one of: ${values.join(", ")}`, path);
      }
      return value as T[number];
    },
  };
}

export function vNullable<T>(inner: Validator<T>): Validator<T | null> {
  return {
    parse(value, path = "value") {
      if (value === null) return null;
      return inner.parse(value, path);
    },
  };
}

export function vArray<T>(
  inner: Validator<T>,
  options?: { maxItems?: number },
): Validator<T[]> {
  const maxItems = options?.maxItems ?? 5_000;
  return {
    parse(value, path = "value") {
      if (!Array.isArray(value)) fail("expected an array", path);
      if (value.length > maxItems) fail(`array exceeds ${maxItems} items`, path);
      return value.map((item, index) => inner.parse(item, `${path}[${index}]`));
    },
  };
}

export function vOptional<T>(inner: Validator<T>): OptionalValidator<T> {
  return {
    [optionalMarker]: true,
    parse: (value, path) => inner.parse(value, path),
  };
}

type AnyFieldValidator = Validator<unknown> | OptionalValidator<unknown>;

function isOptional(validator: AnyFieldValidator): boolean {
  return optionalMarker in validator;
}

/**
 * Strict object validator: the value must be a plain object, unknown keys are
 * rejected, required keys must be present, and optional keys are validated
 * only when present and not undefined. `T` names the parsed shape; `fields`
 * must cover every key of `T`.
 */
export function vObject<T extends object>(fields: {
  [K in keyof Required<T>]: AnyFieldValidator;
}): Validator<T> {
  const fieldEntries = Object.entries(fields) as Array<[string, AnyFieldValidator]>;
  const knownKeys = new Set(fieldEntries.map(([key]) => key));
  return {
    parse(value, path = "value") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("expected an object", path);
      }
      for (const key of Object.keys(value)) {
        if (!knownKeys.has(key)) fail(`unknown key "${key}"`, path);
      }
      const record = value as Record<string, unknown>;
      const parsed: Record<string, unknown> = {};
      for (const [key, validator] of fieldEntries) {
        const present = key in record && record[key] !== undefined;
        if (!present) {
          if (!isOptional(validator)) fail(`missing required key "${key}"`, path);
          continue;
        }
        parsed[key] = validator.parse(record[key], `${path}.${key}`);
      }
      return parsed as T;
    },
  };
}

/** Adds a cross-field predicate on top of an existing validator. */
export function vRefine<T>(
  inner: Validator<T>,
  predicate: (value: T) => boolean,
  message: string,
): Validator<T> {
  return {
    parse(value, path = "value") {
      const parsed = inner.parse(value, path);
      if (!predicate(parsed)) fail(message, path);
      return parsed;
    },
  };
}
