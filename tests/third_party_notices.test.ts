/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import {describe, it} from 'node:test';

function normalizeNoticeContent(content: string): string {
  return content
    .replace(/^Version: .*$/gm, 'Version: <VERSION>')
    .replaceAll('\r', '')
    .replace(/[ \t]+$/gm, '');
}

describe('THIRD_PARTY_NOTICES', () => {
  it('normalizes trailing whitespace from vendored licenses', t => {
    t.assert.equal(normalizeNoticeContent('MIT License \n'), 'MIT License\n');
  });

  it('matches snapshot', t => {
    const noticesPath = path.join(
      process.cwd(),
      'build/src/third_party/THIRD_PARTY_NOTICES',
    );
    if (!fs.existsSync(noticesPath)) {
      throw new Error(
        'THIRD_PARTY_NOTICES does not exist, run `npm ci && npm run bundle`',
      );
    }
    const content = fs.readFileSync(noticesPath, 'utf-8');
    const normalizedContent = normalizeNoticeContent(content);
    t.assert.snapshot(normalizedContent);
  });
});
