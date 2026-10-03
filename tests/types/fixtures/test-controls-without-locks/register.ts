import { test } from '@rehearsal-labs/retest'

// A registered config with no locks takes none, so every lock is declared before a test holds it.
test('holds an undeclared lock', { locks: ['inbox'] }, async () => {}) // type-error TS2322 The config declares no locks.
test('holds none', { locks: [] }, async () => {})
