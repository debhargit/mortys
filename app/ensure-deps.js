// ensure-deps.js
//
// Restores node_modules from vendor\node_modules.zip, for a machine that has
// no npm to install them with. start-melthahonda.bat calls this only after it
// has already tried npm, so getting here means "npm is unavailable or failed".
//
// Why this exists at all: the Node runtime vendored in vendor\ is the bare
// node.exe published by nodejs.org, and that download does NOT include npm.
// On a fresh Windows machine with nothing installed, there is therefore no
// way to run `npm install` -- the archive is the only route to a working
// dependency tree.
//
// The extraction goes through the \\?\ extended-length prefix. Without it this
// fails part-way with DirectoryNotFoundException on a machine where the
// project sits in a deep folder: the longest path in the tree is
//
//   node_modules\twilio\lib\rest\api\v2010\account\sip\domain\authTypes\
//     authTypeRegistrations\authRegistrationsCredentialListMapping.d.ts
//
// at 133 characters, so a project folder deeper than ~125 characters blows the
// 260-character MAX_PATH limit. Two thirds of the files land and the rest
// silently do not, which presents later as a missing-module crash rather than
// as a failed install. (build-portable.ps1 hit the same wall from the other
// direction -- see its Remove-Tree comment.)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const ZIP = path.join(ROOT, 'vendor', 'node_modules.zip');
const SENTINEL = path.join(ROOT, 'node_modules', 'express', 'package.json');

function log(msg) {
  console.log('       ' + msg);
}

// \\?\C:\dir for a local path, \\?\UNC\server\share for a network one. The
// prefix only accepts backslashes -- forward slashes are not normalised inside
// it -- which is why the entry names get their separators rewritten below.
function longPath(p) {
  if (p.startsWith('\\\\?\\')) return p;
  if (p.startsWith('\\\\')) return '\\\\?\\UNC\\' + p.slice(2);
  return '\\\\?\\' + p;
}

function main() {
  if (fs.existsSync(SENTINEL)) {
    log('dependencies already present');
    return 0;
  }
  if (!fs.existsSync(ZIP)) {
    console.error('       ERROR: npm is unavailable and vendor\\node_modules.zip is missing.');
    console.error('       Restore the archive, or install Node.js (which brings npm) and');
    console.error('       run "npm install" in this folder.');
    return 1;
  }

  log('unpacking vendor\\node_modules.zip -- this takes a few minutes...');

  // Written to a file rather than passed with -Command: the quoting gets
  // unreadable inline, and a script file is also what we would want to look
  // at if this ever failed on a customer machine.
  const ps = path.join(os.tmpdir(), 'mh-unpack-deps-' + process.pid + '.ps1');
  fs.writeFileSync(ps, [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$zip = [System.IO.Compression.ZipFile]::OpenRead('" + ZIP + "')",
    "$prefix = '" + longPath(ROOT) + "\\'",
    "$n = 0",
    "try {",
    "  foreach ($e in $zip.Entries) {",
    "    if ($e.FullName.EndsWith('/')) { continue }",
    // [char]47 / [char]92 rather than a quoted '/' and '\': a literal
    // backslash inside a quoted pair here is a reliable way to confuse both
    // the batch layer that may invoke this and anything else reading it back.
    "    $dest = $prefix + $e.FullName.Replace([char]47, [char]92)",
    "    $dir = $dest.Substring(0, $dest.LastIndexOf([char]92))",
    "    [void][System.IO.Directory]::CreateDirectory($dir)",
    "    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)",
    "    $n++",
    "  }",
    "} finally { $zip.Dispose() }",
    "Write-Output $n",
  ].join('\r\n'));

  let out;
  try {
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps],
      { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) {
      console.error('       ERROR: unpacking failed -- ' +
                    String(r.stderr || r.stdout || '').trim().slice(-500));
      return 1;
    }
    out = String(r.stdout || '').trim();
  } finally {
    try { fs.unlinkSync(ps); } catch (_) {}
  }

  log('unpacked ' + out + ' files');

  // Checked rather than assumed: a partial extraction is the failure mode this
  // whole script exists to avoid, and it is invisible until something crashes
  // three screens later looking for a module that was never written.
  if (!fs.existsSync(SENTINEL)) {
    console.error('       ERROR: node_modules\\express is still missing after unpacking.');
    return 1;
  }
  return 0;
}

process.exit(main());
