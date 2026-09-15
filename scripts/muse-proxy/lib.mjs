#!/usr/bin/env node
/**
 * Shared helpers for the traffic-interception parity harness.
 *
 * Every write performed by this directory is funneled through `assertAllowedPath`:
 * the only permitted write roots are the repository itself and `/tmp/opencode`.
 * Nothing here can touch the system CA store, /etc/hosts or /etc/resolv.conf.
 *
 * Certificates are produced by shelling out to the `openssl` CLI (no npm
 * dependency): Node's built-in crypto cannot sign X.509 certificates.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { createSecureContext } from "node:tls";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root (`scripts/muse-proxy/` -> two levels up). */
export const REPO_ROOT = resolve(HERE, "..", "..");
/** The only non-repo scratch root this harness may write to. */
export const TMP_ROOT = "/tmp/opencode";
/** Default location for the generated CA and leaf certificates. */
export const DEFAULT_CERT_DIR = join(HERE, ".certs");

const ALLOWED_WRITE_ROOTS = [REPO_ROOT, TMP_ROOT];

/** Resolve a path and refuse it unless it lives under the repo or `/tmp/opencode`. */
export function assertAllowedPath(target, label = "path") {
	const resolved = resolve(target);
	const allowed = ALLOWED_WRITE_ROOTS.some((root) => resolved === root || resolved.startsWith(root + sep));
	if (!allowed) {
		throw new Error(
			`${label} would write outside the allowed roots (${ALLOWED_WRITE_ROOTS.join(", ")}): ${resolved}`,
		);
	}
	return resolved;
}

export function ensureDir(dir) {
	const resolved = assertAllowedPath(dir, "directory");
	mkdirSync(resolved, { recursive: true });
	return resolved;
}

export function writeFileGuarded(target, data) {
	const resolved = assertAllowedPath(target, "file");
	mkdirSync(dirname(resolved), { recursive: true });
	writeFileSync(resolved, data);
	return resolved;
}

export function appendJsonLineGuarded(target, value) {
	const resolved = assertAllowedPath(target, "log");
	mkdirSync(dirname(resolved), { recursive: true });
	appendFileSync(resolved, `${JSON.stringify(value)}\n`);
	return resolved;
}

export function readJsonFile(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function log(message) {
	process.stderr.write(`[muse-proxy] ${message}\n`);
}

/** Minimal argv parser: `--flag`, `--opt value`, `--opt=value`, arrays and `--`. */
export function parseCliArgs(argv, spec) {
	const options = {};
	const flags = new Map();
	for (const [name, def] of Object.entries(spec)) {
		options[name] = def.default;
		flags.set(`--${name}`, name);
		for (const alias of def.alias ?? []) flags.set(alias, name);
	}
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			positional.push(...argv.slice(i + 1));
			break;
		}
		const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		const name = flags.get(flag);
		if (name === undefined) {
			positional.push(arg);
			continue;
		}
		const def = spec[name];
		const inline = eq === -1 ? undefined : arg.slice(eq + 1);
		if (def.type === "boolean") {
			options[name] = true;
			continue;
		}
		const value = inline ?? argv[++i];
		if (value === undefined) throw new Error(`missing value for ${flag}`);
		if (def.type === "number") options[name] = Number(value);
		else if (def.type === "array") options[name].push(value);
		else options[name] = value;
	}
	return { options, positional };
}

export function splitHostPort(authority) {
	const trimmed = String(authority ?? "").trim();
	if (trimmed.startsWith("[")) {
		const end = trimmed.indexOf("]");
		const host = trimmed.slice(1, end);
		const port = trimmed.slice(end + 2) || "443";
		return { host, port: Number(port) };
	}
	const colon = trimmed.lastIndexOf(":");
	if (colon === -1) return { host: trimmed, port: 443 };
	return { host: trimmed.slice(0, colon), port: Number(trimmed.slice(colon + 1)) || 443 };
}

/**
 * Redact credential-shaped headers before anything is written to disk. The
 * parity diff normalizes these anyway, and the logs must never retain tokens.
 */
export function redactHeaders(headers = {}) {
	const redacted = {};
	for (const [key, value] of Object.entries(headers)) {
		if (/authorization|cookie|api[-_]?key|token|secret|session/i.test(key)) redacted[key] = "<redacted>";
		else if (Array.isArray(value)) redacted[key] = value.join(", ");
		else redacted[key] = value;
	}
	return redacted;
}

export function sseFrame(event) {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Serialize a Responses-API event list as an SSE stream ending in `[DONE]`. */
export function serializeSse(events) {
	if (!Array.isArray(events) || events.length === 0) throw new Error("fixture turn has no events");
	return `${events.map(sseFrame).join("")}data: [DONE]\n\n`;
}

export function openssl(args) {
	const result = spawnSync("openssl", args, { encoding: "utf8" });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`openssl ${args[0]} failed (${result.status}): ${result.stderr || result.stdout}`);
	}
	return result.stdout;
}

export function caPaths(certDir = DEFAULT_CERT_DIR) {
	return {
		key: join(certDir, "ca.key"),
		cert: join(certDir, "ca.pem"),
		bundle: join(certDir, "ca-bundle.pem"),
		serial: join(certDir, "ca.srl"),
	};
}

function systemCaBundlePath() {
	if (process.env.SSL_CERT_FILE && existsSync(process.env.SSL_CERT_FILE)) return process.env.SSL_CERT_FILE;
	const candidates = [
		"/etc/ssl/certs/ca-certificates.crt",
		"/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
		"/etc/ssl/ca-bundle.pem",
		"/etc/pki/tls/cacert.pem",
		"/etc/ssl/cert.pem",
	];
	for (const candidate of candidates) if (existsSync(candidate)) return candidate;
	throw new Error(`no system CA bundle found among: ${candidates.join(", ")}`);
}

/**
 * Create (or reuse) a local CA and a `ca-bundle.pem` that contains the system
 * roots plus our CA, so a client pointed at it via `SSL_CERT_FILE` can still
 * reach every normal host.
 */
export function ensureCa(certDir = DEFAULT_CERT_DIR, { force = false } = {}) {
	ensureDir(certDir);
	const paths = caPaths(certDir);
	if (force || !existsSync(paths.key) || !existsSync(paths.cert)) {
		openssl(["genrsa", "-out", paths.key, "2048"]);
		openssl([
			"req",
			"-x509",
			"-new",
			"-nodes",
			"-key",
			paths.key,
			"-sha256",
			"-days",
			"3650",
			"-subj",
			"/CN=pi-muse-parity-ca",
			"-out",
			paths.cert,
			"-addext",
			"basicConstraints=critical,CA:TRUE",
			"-addext",
			"keyUsage=critical,keyCertSign,cRLSign",
		]);
	}
	const systemBundle = readFileSync(systemCaBundlePath(), "utf8").trimEnd();
	const ourCa = readFileSync(paths.cert, "utf8").trimEnd();
	// Our CA goes FIRST: the real muse binary's PEM loader only picks up the
	// first certificate in SSL_CERT_FILE (verified: a system-roots-first bundle
	// produced `tlsv1 alert unknown ca`). Multi-cert readers still see every
	// system root that follows.
	writeFileGuarded(
		paths.bundle,
		`# pi-muse-parity local CA (prepended by scripts/muse-proxy/certs.mjs)\n${ourCa}\n\n${systemBundle}\n`,
	);
	return {
		dir: certDir,
		keyPath: paths.key,
		certPath: paths.cert,
		bundlePath: paths.bundle,
		systemBundlePath: systemCaBundlePath(),
	};
}

/** Mint (or reuse) a leaf certificate for `host`, signed by the local CA. */
export function mintLeafCert(host, certDir = DEFAULT_CERT_DIR) {
	ensureDir(certDir);
	const ca = caPaths(certDir);
	if (!existsSync(ca.key) || !existsSync(ca.cert)) ensureCa(certDir);
	const safe = host.replace(/[^a-zA-Z0-9._-]/g, "_");
	const dir = join(certDir, "leaves", safe);
	const keyPath = join(dir, "leaf.key");
	const certPath = join(dir, "leaf.pem");
	if (existsSync(keyPath) && existsSync(certPath)) {
		return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
	}
	ensureDir(dir);
	const csrPath = join(dir, "leaf.csr");
	const extPath = join(dir, "leaf.ext");
	const san = isIP(host) ? `IP:${host},IP:127.0.0.1,DNS:localhost` : `DNS:${host},DNS:localhost,IP:127.0.0.1`;
	openssl([
		"req",
		"-new",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		keyPath,
		"-out",
		csrPath,
		"-subj",
		`/CN=${host}`,
	]);
	writeFileGuarded(
		extPath,
		[
			"basicConstraints=CA:FALSE",
			"keyUsage=critical,digitalSignature,keyEncipherment",
			"extendedKeyUsage=serverAuth",
			`subjectAltName=${san}`,
			"",
		].join("\n"),
	);
	openssl([
		"x509",
		"-req",
		"-in",
		csrPath,
		"-CA",
		ca.cert,
		"-CAkey",
		ca.key,
		"-CAcreateserial",
		"-CAserial",
		ca.serial,
		"-out",
		certPath,
		"-days",
		"825",
		"-sha256",
		"-extfile",
		extPath,
	]);
	return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
}

export function secureContextForHost(host, certDir = DEFAULT_CERT_DIR) {
	const leaf = mintLeafCert(host, certDir);
	return createSecureContext({ key: leaf.key, cert: leaf.cert });
}
