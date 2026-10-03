// selftest.mjs — run before every push. Catches the "file silently
// truncated or null-padded by a sync hazard" failure mode: a truncated file
// still often "parses", but deploys to a blank page or a worker that does
// nothing. Checks syntax AND minimum shape, not just that files exist.
// Adapted from the Dashboard repo's selftest.mjs for this app's own file set.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
let failed = false;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failed = true;
}
function ok(msg) {
  console.log(`ok:   ${msg}`);
}

function checkNoNulls(file, content) {
  if (content.includes("\u0000")) fail(`${file}: contains null bytes (truncation/sync hazard)`);
}

function checkJsSyntax(relPath) {
  const full = path.join(root, relPath);
  if (!existsSync(full)) return fail(`${relPath}: missing`);
  const content = readFileSync(full, "utf8");
  checkNoNulls(relPath, content);
  if (content.length < 200) return fail(`${relPath}: suspiciously short (${content.length} bytes) — likely truncated`);
  try {
    execFileSync(process.execPath, ["--check", full], { stdio: "pipe" });
    ok(`${relPath}: syntax OK (${content.length} bytes)`);
  } catch (e) {
    fail(`${relPath}: syntax error — ${e.stderr ? e.stderr.toString() : e.message}`);
  }
}

// JS files
["worker.js", "lib/periods.js", "lib/square.js", "lib/auth.js", "lib/employmenthero.js", "lib/awardRates.js"].forEach(checkJsSyntax);

// public/index.html — must be named exactly this or the static-assets host
// won't serve it for "/". Self-tested for truncation too.
{
  const relPath = "public/index.html";
  const full = path.join(root, relPath);
  if (!existsSync(full)) {
    fail(`${relPath}: missing`);
  } else {
    const content = readFileSync(full, "utf8");
    checkNoNulls(relPath, content);
    if (content.length < 2000) fail(`${relPath}: suspiciously short (${content.length} bytes) — likely truncated`);
    const trimmed = content.trim();
    if (!trimmed.startsWith("<!DOCTYPE html")) fail(`${relPath}: doesn't start with <!DOCTYPE html> — truncated at the head?`);
    if (!trimmed.endsWith("</html>")) fail(`${relPath}: doesn't end with </html> — truncated at the tail`);
    if (!content.includes("</script>")) fail(`${relPath}: missing closing </script> — truncated mid-script`);
    ok(`${relPath}: shape OK (${content.length} bytes)`);
  }
}

// wrangler.toml — required keys present, and the KV id must be the real
// SHARED namespace id, not a placeholder.
{
  const relPath = "wrangler.toml";
  const full = path.join(root, relPath);
  if (!existsSync(full)) {
    fail(`${relPath}: missing`);
  } else {
    const content = readFileSync(full, "utf8");
    checkNoNulls(relPath, content);
    for (const needle of ['name =', 'main = "worker.js"', "[assets]", "[[kv_namespaces]]", 'binding = "TOKENS"']) {
      if (!content.includes(needle)) fail(`${relPath}: missing expected "${needle}"`);
    }
    const kvBlockMatch = content.match(/\[\[kv_namespaces\]\][^[]*/);
    if (kvBlockMatch && /^\s*id\s*=\s*"(REPLACE|CHANGE|TODO|xxx)/im.test(kvBlockMatch[0])) {
      fail(`${relPath}: kv_namespaces has a placeholder id — this must be the Dashboard's real, shared namespace id`);
    }
    if (!content.includes('id = "facc394b09a240b38e4213fb5e7a1d0b"')) {
      fail(`${relPath}: kv_namespaces id doesn't match the Dashboard repo's shared namespace — this app won't see the Dashboard's data`);
    }
    ok(`${relPath}: required keys present, shared KV id intact`);
  }
}

// package.json — valid JSON, has deploy script, wrangler version new enough.
{
  const relPath = "package.json";
  const full = path.join(root, relPath);
  if (!existsSync(full)) {
    fail(`${relPath}: missing`);
  } else {
    const content = readFileSync(full, "utf8");
    checkNoNulls(relPath, content);
    try {
      const pkg = JSON.parse(content);
      if (!pkg.scripts || !pkg.scripts.deploy) fail(`${relPath}: missing scripts.deploy`);
      else ok(`${relPath}: valid JSON, deploy script present`);
    } catch (e) {
      fail(`${relPath}: invalid JSON — ${e.message}`);
    }
  }
}

if (failed) {
  console.error("\nself-test FAILED — do not push. If a file looks truncated/null-padded, rebuild it via the shell (not the editor) into a fresh copy and re-run.");
  process.exit(1);
} else {
  console.log("\nself-test PASSED — safe to push.");
}
