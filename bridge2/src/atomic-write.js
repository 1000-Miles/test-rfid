'use strict';

/**
 * Crash-safe file replacement: write the full content to a sibling temp file,
 * fsync it, then rename over the destination.
 *
 * Plain fs.writeFileSync truncates the destination BEFORE writing, so a process
 * killed mid-write destroys the last good copy — fatal for snapshot files like
 * the movement cursor, the board cache, and the offline tag catalog, where the
 * old complete file is always more useful than half of a new one. With the
 * rename, a kill at any instant leaves either the old file or the new file,
 * never a truncated mix.
 *
 * Directory fsync (making the rename itself durable) is best-effort: Windows
 * cannot open directories for fsync, and the rename is still atomic without it.
 */

const fs = require('fs');
const path = require('path');

function writeFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  try {
    const dfd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    /* Windows: directories can't be fsynced — see the module docblock */
  }
}

module.exports = { writeFileAtomic };
