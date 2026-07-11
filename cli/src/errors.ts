// Shared error types. Kept in one small module so every other module (and the
// stub verbs) can throw structured errors without importing each other.

/** Bad CLI invocation (unknown verb/flag, missing argument). Maps to exit 1. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Registry failed schema validation. */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/** Machine config invalid, or a registered root is missing on disk (hard abort). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * An authoring error where two artifacts want the same placement (AUR-616): a
 * derived skill whose normalized name collides with a native skill (or another
 * derived skill). Hard-fails the plan deterministically before any mutation.
 */
export class CollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollisionError";
  }
}
