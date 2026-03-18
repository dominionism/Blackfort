// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Policy preset management — list, load, merge, and apply presets.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { ROOT, run, runCapture } = require("./runner");
const registry = require("./registry");

const PRESETS_DIR = path.join(ROOT, "nemoclaw-blueprint", "policies", "presets");
const BASE_POLICY_FILE = path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
const LOCKDOWN_PROFILES = {
  "local-only": {
    description: "Reset to the strict baseline policy with only NVIDIA inference egress.",
    presets: [],
  },
  "github-pr": {
    description: "Allow only baseline egress plus GitHub HTTPS/API access for git/curl-based repo work.",
    presets: ["github"],
  },
};

function listPresets() {
  if (!fs.existsSync(PRESETS_DIR)) return [];
  return fs
    .readdirSync(PRESETS_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => {
      const content = fs.readFileSync(path.join(PRESETS_DIR, f), "utf-8");
      const nameMatch = content.match(/^\s*name:\s*(.+)$/m);
      const descMatch = content.match(/^\s*description:\s*"?([^"]*)"?$/m);
      return {
        file: f,
        name: nameMatch ? nameMatch[1].trim() : f.replace(".yaml", ""),
        description: descMatch ? descMatch[1].trim() : "",
      };
    });
}

function loadPreset(name) {
  const file = path.join(PRESETS_DIR, `${name}.yaml`);
  if (!fs.existsSync(file)) {
    console.error(`  Preset not found: ${name}`);
    return null;
  }
  return fs.readFileSync(file, "utf-8");
}

function getPresetEndpoints(content) {
  const hosts = [];
  const regex = /host:\s*([^\s,}]+)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    hosts.push(match[1]);
  }
  return hosts;
}

/**
 * Extract just the network_policies entries (indented content under
 * the `network_policies:` key) from a preset file, stripping the
 * `preset:` metadata header.
 */
function extractPresetEntries(presetContent) {
  const npMatch = presetContent.match(/^network_policies:\n([\s\S]*)$/m);
  if (!npMatch) return null;
  return npMatch[1].trimEnd();
}

function mergePolicyEntries(policyYaml, presetEntries) {
  if (!presetEntries) return policyYaml;

  if (policyYaml && policyYaml.includes("network_policies:")) {
    const lines = policyYaml.split("\n");
    const result = [];
    let inNetworkPolicies = false;
    let inserted = false;

    for (const line of lines) {
      const isTopLevel = /^\S.*:/.test(line);

      if (line.trim() === "network_policies:" || line.trim().startsWith("network_policies:")) {
        inNetworkPolicies = true;
        result.push(line);
        continue;
      }

      if (inNetworkPolicies && isTopLevel && !inserted) {
        result.push(presetEntries);
        inserted = true;
        inNetworkPolicies = false;
      }

      result.push(line);
    }

    if (inNetworkPolicies && !inserted) {
      result.push(presetEntries);
    }

    return result.join("\n");
  }

  if (policyYaml) {
    const withVersion = policyYaml.includes("version:") ? policyYaml : `version: 1\n${policyYaml}`;
    return `${withVersion}\n\nnetwork_policies:\n${presetEntries}`;
  }

  return `version: 1\n\nnetwork_policies:\n${presetEntries}`;
}

/**
 * Parse the output of `openshell policy get --full` which has a metadata
 * header (Version, Hash, etc.) followed by `---` and then the actual YAML.
 */
function parseCurrentPolicy(raw) {
  if (!raw) return "";
  const sep = raw.indexOf("---");
  if (sep === -1) return raw;
  return raw.slice(sep + 3).trim();
}

function extractPolicyHosts(policyYaml) {
  const hosts = [];
  const regex = /^\s*-?\s*host:\s*([^\s,}]+)\s*$/gm;
  let match;
  while ((match = regex.exec(policyYaml)) !== null) {
    hosts.push(match[1]);
  }
  return [...new Set(hosts)].sort();
}

function baselinePolicyYaml() {
  return fs.readFileSync(BASE_POLICY_FILE, "utf-8").trimEnd();
}

function buildPolicyFromPresets(presetNames = []) {
  let policyYaml = baselinePolicyYaml();
  for (const presetName of presetNames) {
    const presetContent = loadPreset(presetName);
    if (!presetContent) {
      throw new Error(`Cannot load preset: ${presetName}`);
    }
    const presetEntries = extractPresetEntries(presetContent);
    if (!presetEntries) {
      throw new Error(`Preset ${presetName} has no network_policies section.`);
    }
    policyYaml = mergePolicyEntries(policyYaml, presetEntries);
  }
  return policyYaml.trimEnd();
}

function applyPolicyYaml(sandboxName, policyYaml) {
  const tmpFile = path.join(os.tmpdir(), `nemoclaw-policy-${Date.now()}.yaml`);
  fs.writeFileSync(tmpFile, policyYaml, { encoding: "utf-8", mode: 0o600 });

  try {
    run("openshell", ["policy", "set", "--policy", tmpFile, "--wait", sandboxName]);
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function setExactPresets(sandboxName, presetNames = []) {
  const policyYaml = buildPolicyFromPresets(presetNames);
  applyPolicyYaml(sandboxName, policyYaml);

  const sandbox = registry.getSandbox(sandboxName);
  if (sandbox) {
    registry.updateSandbox(sandboxName, { policies: [...presetNames] });
  }

  return { policyYaml, hosts: extractPolicyHosts(policyYaml) };
}

function listLockdownProfiles() {
  return Object.entries(LOCKDOWN_PROFILES).map(([name, value]) => ({
    name,
    description: value.description,
    presets: [...value.presets],
  }));
}

function getLockdownProfile(name) {
  return LOCKDOWN_PROFILES[name] || null;
}

function applyLockdownProfile(sandboxName, profileName) {
  const profile = getLockdownProfile(profileName);
  if (!profile) {
    console.error(`  Unknown lockdown profile: ${profileName}`);
    return false;
  }

  const result = setExactPresets(sandboxName, profile.presets);
  console.log(`  Applied lockdown profile: ${profileName}`);
  console.log(`  Active hosts: ${result.hosts.join(", ") || "(none)"}`);
  return true;
}

function getEffectivePolicyYaml(sandboxName) {
  const rawPolicy = runCapture("openshell", ["policy", "get", "--full", sandboxName], {
    ignoreError: true,
  });
  return parseCurrentPolicy(rawPolicy);
}

function getEffectivePolicyHosts(sandboxName) {
  return extractPolicyHosts(getEffectivePolicyYaml(sandboxName));
}

function applyPreset(sandboxName, presetName) {
  const presetContent = loadPreset(presetName);
  if (!presetContent) {
    console.error(`  Cannot load preset: ${presetName}`);
    return false;
  }

  const presetEntries = extractPresetEntries(presetContent);
  if (!presetEntries) {
    console.error(`  Preset ${presetName} has no network_policies section.`);
    return false;
  }

  // Get current policy YAML from sandbox
  let rawPolicy = "";
  try {
    rawPolicy = runCapture("openshell", ["policy", "get", "--full", sandboxName], {
      ignoreError: true,
    });
  } catch {}

  let currentPolicy = parseCurrentPolicy(rawPolicy);

  // Merge: inject preset entries under the existing network_policies key
  const merged = mergePolicyEntries(currentPolicy, presetEntries);
  applyPolicyYaml(sandboxName, merged);
  console.log(`  Applied preset: ${presetName}`);

  // Update registry
  const sandbox = registry.getSandbox(sandboxName);
  if (sandbox) {
    const pols = sandbox.policies || [];
    if (!pols.includes(presetName)) {
      pols.push(presetName);
    }
    registry.updateSandbox(sandboxName, { policies: pols });
  }

  return true;
}

function getAppliedPresets(sandboxName) {
  const sandbox = registry.getSandbox(sandboxName);
  return sandbox ? sandbox.policies || [] : [];
}

module.exports = {
  BASE_POLICY_FILE,
  LOCKDOWN_PROFILES,
  PRESETS_DIR,
  listPresets,
  loadPreset,
  getPresetEndpoints,
  extractPolicyHosts,
  buildPolicyFromPresets,
  applyPreset,
  setExactPresets,
  listLockdownProfiles,
  getLockdownProfile,
  applyLockdownProfile,
  getEffectivePolicyYaml,
  getEffectivePolicyHosts,
  getAppliedPresets,
};
