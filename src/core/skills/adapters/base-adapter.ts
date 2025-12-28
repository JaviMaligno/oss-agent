/**
 * Base Skill Adapter
 *
 * Abstract interface for converting between universal skill format
 * and provider-specific formats.
 */

import type { ProviderType, SkillAdapter, SkillMetadata, UniversalSkill } from "../types.js";

/**
 * Base class for skill adapters.
 * Provides common functionality and enforces the adapter interface.
 */
export abstract class BaseSkillAdapter<T> implements SkillAdapter<T> {
  abstract provider: ProviderType;

  /**
   * Convert a universal skill to the provider-specific format.
   */
  abstract adapt(skill: UniversalSkill): T;

  /**
   * Parse a provider-specific format into a universal skill.
   */
  abstract parse(input: T, metadata: SkillMetadata): UniversalSkill;

  /**
   * Check if this adapter supports a given provider.
   */
  supports(provider: ProviderType): boolean {
    return this.provider === provider;
  }

  /**
   * Validate a universal skill has content for this provider.
   */
  protected hasProviderContent(skill: UniversalSkill): boolean {
    return skill.providers[this.provider] !== undefined;
  }

  /**
   * Get default version if not specified.
   */
  protected getVersion(metadata: SkillMetadata): string {
    return metadata.version ?? "1.0.0";
  }
}

/**
 * Factory for creating skill adapters.
 */
export class SkillAdapterFactory {
  private adapters: Map<ProviderType, SkillAdapter> = new Map();

  /**
   * Register an adapter for a provider.
   */
  register<T>(adapter: SkillAdapter<T>): void {
    this.adapters.set(adapter.provider, adapter);
  }

  /**
   * Get an adapter for a provider.
   */
  get<T>(provider: ProviderType): SkillAdapter<T> | undefined {
    return this.adapters.get(provider) as SkillAdapter<T> | undefined;
  }

  /**
   * Check if an adapter is registered for a provider.
   */
  has(provider: ProviderType): boolean {
    return this.adapters.has(provider);
  }

  /**
   * List all registered providers.
   */
  providers(): ProviderType[] {
    return Array.from(this.adapters.keys());
  }
}

/**
 * Global adapter factory instance.
 */
export const adapterFactory = new SkillAdapterFactory();
