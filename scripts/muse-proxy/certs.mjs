#!/usr/bin/env node
/**
 * Create or reuse the local MITM CA and the combined `ca-bundle.pem`
 * (system roots + our CA) used to point a client at the harness.
 *
 *   node scripts/muse-proxy/certs.mjs [--cert-dir <dir>] [--force] [--json]
 *
 * `--cert-dir` defaults to `scripts/muse-proxy/.certs`, which is the only
 * non-temporary location this harness ever writes to (plus `/tmp/opencode`).
 * The system CA store, /etc/hosts and /etc/resolv.conf are never touched:
 * the client is redirected with environment variables only.
 */
import { DEFAULT_CERT_DIR, ensureCa, log, parseCliArgs } from "./lib.mjs";

const { options } = parseCliArgs(process.argv.slice(2), {
	"cert-dir": { type: "string", default: DEFAULT_CERT_DIR, alias: ["--cert-dir"] },
	force: { type: "boolean", default: false },
	json: { type: "boolean", default: false },
	help: { type: "boolean", default: false },
});

if (options.help) {
	process.stdout.write(
		[
			"usage: node scripts/muse-proxy/certs.mjs [--cert-dir <dir>] [--force] [--json]",
			"",
			"Generates a local CA and a ca-bundle.pem that appends it to the system roots.",
			"Writes only under --cert-dir (default scripts/muse-proxy/.certs).",
			"",
		].join("\n"),
	);
	process.exit(0);
}

const result = ensureCa(options["cert-dir"], { force: options.force });

if (options.json) {
	process.stdout.write(
		`${JSON.stringify(
			{
				certDir: result.dir,
				caKey: result.keyPath,
				caCert: result.certPath,
				caBundle: result.bundlePath,
				systemBundle: result.systemBundlePath,
			},
			null,
			"\t",
		)}\n`,
	);
} else {
	log(`CA directory: ${result.dir}`);
	log(`CA certificate: ${result.certPath}`);
	log(`Combined CA bundle (system roots + our CA): ${result.bundlePath}`);
	log(`System roots used: ${result.systemBundlePath}`);
	process.stdout.write(`${result.bundlePath}\n`);
}
