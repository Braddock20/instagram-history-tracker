import { unzipSync } from "fflate";
import { usernameFromEntry } from "./normalize";
import type { Env, ParsedExport } from "./types";

function json(bytes: Uint8Array) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

function isFollowers(path: string) {
  const x = path.toLowerCase();
  return /(^|[/\\])followers(?:[_-]\d+)?\.json$/.test(x) || /followers[_-]\d+\.json$/.test(x);
}

function isFollowing(path: string) {
  const x = path.toLowerCase();
  return /(^|[/\\])following(?:[_-]\d+)?\.json$/.test(x) || /following\.json$/.test(x);
}

export function parseInstagramZip(bytes: Uint8Array, env: Env): ParsedExport {
  const files = unzipSync(bytes);
  const names = Object.keys(files);
  const maxFiles = Number(env.MAX_USERNAME_COUNT || 5000) * 2;
  if (names.length > maxFiles) throw new Error(`ZIP contains ${names.length} files; maximum is ${maxFiles}`);

  const jsonNames = names.filter(n => n.toLowerCase().endsWith(".json"));
  const followerFiles = jsonNames.filter(isFollowers);
  const followingFiles = jsonNames.filter(isFollowing);
  if (!followerFiles.length) throw new Error("No followers JSON file was found in the ZIP");
  if (!followingFiles.length) throw new Error("No following JSON file was found in the ZIP");

  const followers = new Set<string>();
  const following = new Set<string>();
  const warnings: string[] = [];
  const maxJson = 50_000_000;

  for (const name of followerFiles) {
    if (files[name].byteLength > maxJson) throw new Error(`${name} exceeds the JSON file limit`);
    let parsed: any;
    try { parsed = json(files[name]); } catch { throw new Error(`${name} is not valid JSON`); }
    if (!Array.isArray(parsed)) { warnings.push(`${name} did not contain a root array`); continue; }
    let recognized = 0;
    for (const entry of parsed) {
      const username = usernameFromEntry(entry);
      if (username) { followers.add(username); recognized++; }
    }
    if (!recognized) warnings.push(`${name} contained no recognizable usernames`);
  }

  for (const name of followingFiles) {
    if (files[name].byteLength > maxJson) throw new Error(`${name} exceeds the JSON file limit`);
    let parsed: any;
    try { parsed = json(files[name]); } catch { throw new Error(`${name} is not valid JSON`); }
    const entries = Array.isArray(parsed) ? parsed : parsed?.relationships_following;
    if (!Array.isArray(entries)) { warnings.push(`${name} did not contain a recognizable following list`); continue; }
    let recognized = 0;
    for (const entry of entries) {
      const username = usernameFromEntry(entry);
      if (username) { following.add(username); recognized++; }
    }
    if (!recognized) warnings.push(`${name} contained no recognizable usernames`);
  }

  if (!followers.size) throw new Error("The export contained zero recognizable followers");
  if (!following.size) throw new Error("The export contained zero recognizable following accounts");
  return { followers, following, discoveredFiles: names, followerFiles, followingFiles, warnings };
}
