import { describe, expect, it } from 'vitest';
import { canReviewScene, canServeScene, demoImportError, generationDedupeKey, processorInputError } from '../src/index.js';

describe('processor and publication gates', () => {
  it('allows only the currently active approved version of a published tour', () => {
    const current = { id: 'v2', review_status: 'approved' };
    const published = { state: 'published', published_at: '2026-11-13T00:00:00Z', active_scene_version: 'v2' };
    expect(canServeScene(published, current)).toBe(true);
    expect(canServeScene({ ...published, state: 'ready_for_review' }, current)).toBe(false);
    expect(canServeScene(published, { ...current, review_status: 'pending' })).toBe(false);
    expect(canServeScene({ ...published, active_scene_version: 'v1' }, current)).toBe(false);
    expect(canServeScene({ ...published, published_at: null }, current)).toBe(false);
  });

  it('rejects missing, overlong, zero, or >100,000,000-byte processor validation', () => {
    expect(processorInputError(undefined, 1)).not.toBeNull();
    expect(processorInputError(30.001, 1)).not.toBeNull();
    expect(processorInputError(30, 100_000_001)).not.toBeNull();
    expect(processorInputError(0, 100)).not.toBeNull();
    expect(processorInputError(30, 100_000_000)).toBeNull();
  });

  it('uses one stable unique generation key per completed upload', () => {
    expect(generationDedupeKey('upload-1')).toBe('generate:upload-1');
    expect(generationDedupeKey('upload-1')).toBe(generationDedupeKey('upload-1'));
    expect(generationDedupeKey('upload-1')).not.toBe(generationDedupeKey('upload-2'));
  });

  it('keeps a locally imported scene private to its owner until approval and publication', () => {
    const scene = { id: 'fixture', review_status: 'pending' };
    expect(canReviewScene('operator', 'operator', scene)).toBe(true);
    expect(canReviewScene('operator', 'visitor', scene)).toBe(false);
    expect(canServeScene({ state: 'ready_for_review', active_scene_version: null, published_at: null }, scene)).toBe(false);
    expect(demoImportError('world', ['poster.webp', 'panorama.png', '100k.spz'])).not.toBeNull();
    expect(demoImportError('world', ['poster.webp', 'panorama.png', '100k.spz', '500k.spz'])).toBeNull();
  });
});
