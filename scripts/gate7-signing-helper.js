const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const STATE = path.join(ROOT, "deployments", "gate7-part1-pending.json");
const HOST = "127.0.0.1";
const START_PORT = Number(process.env.PORT || 8765);
const ATTESTER = "0x07bf9b22f516d2D464511219488F019c5dFF5335";
const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7";

function readPending() {
  const pending = JSON.parse(fs.readFileSync(STATE, "utf8"));
  return {
    ...pending,
    attester: ATTESTER,
    typedData: {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        ...pending.types,
      },
      primaryType: "MintRequest",
      domain: pending.domain,
      message: pending.message,
    },
  };
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gate 7 Part 1 Signer</title>
  <style>
    :root {
      color-scheme: light;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f7f7f4;
      color: #161616;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; }
    main { width: min(980px, calc(100vw - 32px)); margin: 0 auto; padding: 32px 0 48px; }
    h1 { font-size: 28px; line-height: 1.15; margin: 0 0 8px; }
    h2 { font-size: 15px; margin: 24px 0 10px; text-transform: uppercase; letter-spacing: .04em; color: #57534e; }
    p { margin: 8px 0; color: #3f3f3f; }
    button {
      border: 1px solid #111;
      background: #111;
      color: #fff;
      border-radius: 6px;
      padding: 10px 14px;
      font: inherit;
      cursor: pointer;
      min-height: 42px;
    }
    button.secondary { background: #fff; color: #111; border-color: #b8b5ad; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
    .panel {
      border: 1px solid #d8d4ca;
      border-radius: 8px;
      background: #fff;
      padding: 18px;
      margin-top: 18px;
    }
    .grid { display: grid; grid-template-columns: 190px 1fr; gap: 10px 14px; align-items: start; }
    .label { color: #6b665f; }
    code, textarea, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
    }
    code { overflow-wrap: anywhere; }
    textarea {
      width: 100%;
      min-height: 108px;
      resize: vertical;
      border: 1px solid #c9c4ba;
      border-radius: 6px;
      padding: 10px;
      color: #111;
      background: #fbfaf8;
    }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 0;
      background: #fbfaf8;
      border: 1px solid #e3dfd7;
      border-radius: 6px;
      padding: 12px;
      max-height: 320px;
      overflow: auto;
    }
    .status { margin-top: 14px; padding: 10px 12px; border-radius: 6px; background: #efeee9; color: #242424; }
    .status.error { background: #fff0f0; color: #8a1f1f; border: 1px solid #f1c3c3; }
    .status.ok { background: #edf8f0; color: #14532d; border: 1px solid #b9e2c2; }
    @media (max-width: 720px) {
      main { width: min(100vw - 24px, 980px); padding-top: 22px; }
      .grid { grid-template-columns: 1fr; gap: 4px 0; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Gate 7 Part 1 Ledger Signer</h1>
    <p>This local page asks MetaMask to sign the repo's pending EIP-712 mint request. It does not submit a transaction.</p>

    <section class="panel">
      <div class="grid">
        <div class="label">Required signer</div><code id="attester"></code>
        <div class="label">Signing account</div><code id="account">Not connected</code>
        <div class="label">MetaMask accounts</div><code id="accounts">Not connected</code>
        <div class="label">Chain</div><code id="chain">Not connected</code>
        <div class="label">Digest</div><code id="digest"></code>
        <div class="label">Verifier</div><code id="verifier"></code>
        <div class="label">Model</div><code id="model"></code>
        <div class="label">Recipient</div><code id="recipient"></code>
        <div class="label">Candidate</div><code id="candidate"></code>
      </div>
      <div class="actions">
        <button id="connect">Connect MetaMask</button>
        <button id="sign" disabled>Sign typed data</button>
        <button id="copy" class="secondary" disabled>Copy signature</button>
      </div>
      <div id="status" class="status">Loading pending typed data...</div>
    </section>

    <section class="panel">
      <h2>Signature</h2>
      <textarea id="signature" readonly placeholder="The 0x signature will appear here after the Ledger approval."></textarea>
      <p>Submit with: <code>HARDHAT_NETWORK=sepolia node scripts/gate7-part1-sepolia.js submit 0x&lt;signature&gt;</code></p>
    </section>

    <section class="panel">
      <h2>Typed Data Sent To MetaMask</h2>
      <pre id="typedData"></pre>
    </section>
  </main>
  <script>
    const expectedAttester = "${ATTESTER}".toLowerCase();
    const sepoliaChainId = "${SEPOLIA_CHAIN_ID_HEX}";
    let pending;
    let account;
    let accounts = [];

    const el = (id) => document.getElementById(id);
    const setStatus = (message, kind = "") => {
      const node = el("status");
      node.textContent = message;
      node.className = "status" + (kind ? " " + kind : "");
    };
    const shortChain = (id) => id === sepoliaChainId ? "Sepolia (11155111)" : id;
    const findAttester = (items) => (items || []).find((item) => item && item.toLowerCase() === expectedAttester);
    const renderAccounts = () => {
      el("accounts").textContent = accounts.length ? accounts.join(", ") : "Not connected";
      el("account").textContent = account || "Not connected";
    };
    const canSign = () => {
      el("sign").disabled = !pending || !account || account.toLowerCase() !== expectedAttester;
    };

    async function loadPending() {
      const res = await fetch("/pending");
      if (!res.ok) throw new Error("Could not load /pending");
      pending = await res.json();
      el("attester").textContent = pending.attester;
      el("digest").textContent = pending.digest;
      el("verifier").textContent = pending.domain.verifyingContract;
      el("model").textContent = pending.message.modelId;
      el("recipient").textContent = pending.message.contributors[0].walletAddress;
      el("candidate").textContent = pending.message.payload.candidateCommitment;
      el("typedData").textContent = JSON.stringify(pending.typedData, null, 2);
      setStatus("Connect MetaMask with the Ledger account " + pending.attester + ".", "");
    }

    async function connect() {
      if (!window.ethereum) {
        throw new Error("MetaMask was not found. Open this page in a browser with MetaMask installed.");
      }
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: sepoliaChainId }],
        });
      } catch (error) {
        if (error.code !== 4902) throw error;
        throw new Error("Sepolia is not configured in MetaMask. Add Sepolia, then try again.");
      }
      accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      account = findAttester(accounts) || accounts[0];
      renderAccounts();
      const chainId = await window.ethereum.request({ method: "eth_chainId" });
      el("chain").textContent = shortChain(chainId);
      if (account.toLowerCase() !== expectedAttester) {
        setStatus("MetaMask did not expose the required Ledger account. Returned: " + (accounts.join(", ") || "none") + ".", "error");
      } else {
        setStatus("Ready. Found the required Ledger account. Keep the Ethereum app open, then sign typed data.", "ok");
      }
      canSign();
    }

    async function signTypedData() {
      if (!account) await connect();
      if (account.toLowerCase() !== expectedAttester) {
        throw new Error("Selected account is not the required attester.");
      }
      setStatus("MetaMask should now open a signature request. Review and approve it on the Ledger.", "");
      const signature = await window.ethereum.request({
        method: "eth_signTypedData_v4",
        params: [pending.attester, JSON.stringify(pending.typedData)],
      });
      el("signature").value = signature;
      el("copy").disabled = true;
      setStatus("Signature captured. Verifying locally against the pending typed data...", "");
      const verified = await verifySignature(signature);
      el("copy").disabled = false;
      setStatus("Signature verified locally. Recovered " + verified.recovered + ". Copy it into the submit command.", "ok");
    }

    async function verifySignature(signature) {
      const res = await fetch("/verify-signature", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        throw new Error(body.error || "Local signature verification failed.");
      }
      return body;
    }

    async function copySignature() {
      const signature = el("signature").value.trim();
      if (!signature) return;
      await navigator.clipboard.writeText(signature);
      setStatus("Signature copied.", "ok");
    }

    el("connect").addEventListener("click", () => connect().catch((e) => setStatus(e.message || String(e), "error")));
    el("sign").addEventListener("click", () => signTypedData().catch((e) => setStatus(e.message || String(e), "error")));
    el("copy").addEventListener("click", () => copySignature().catch((e) => setStatus(e.message || String(e), "error")));

    if (window.ethereum) {
      window.ethereum.on("accountsChanged", (newAccounts) => {
        accounts = newAccounts;
        account = findAttester(accounts) || accounts[0];
        renderAccounts();
        canSign();
      });
      window.ethereum.on("chainChanged", (chainId) => {
        el("chain").textContent = shortChain(chainId);
      });
    }

    loadPending().catch((e) => setStatus(e.message || String(e), "error"));
  </script>
</body>
</html>`;
}

function send(res, status, body, contentType) {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function verifySignature(req, res) {
  const body = JSON.parse(await readBody(req) || "{}");
  const signature = body.signature;
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature || "")) {
    return send(res, 400, JSON.stringify({ ok: false, error: "Expected a 65-byte 0x signature" }), "application/json; charset=utf-8");
  }

  const pending = readPending();
  let recovered;
  try {
    recovered = ethers.verifyTypedData(pending.domain, pending.types, pending.message, signature);
  } catch (error) {
    return send(res, 400, JSON.stringify({
      ok: false,
      expected: ATTESTER,
      digest: pending.digest,
      error: `Signature could not be verified: ${error.message || error}`,
    }, null, 2), "application/json; charset=utf-8");
  }
  const ok = ethers.getAddress(recovered) === ethers.getAddress(ATTESTER);
  return send(res, ok ? 200 : 400, JSON.stringify({
    ok,
    recovered,
    expected: ATTESTER,
    digest: pending.digest,
    error: ok ? undefined : "Signature does not recover to the required attester for the pending typed data",
  }, null, 2), "application/json; charset=utf-8");
}

function makeServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${HOST}`);
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, html(), "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/pending") return send(res, 200, JSON.stringify(readPending(), null, 2), "application/json; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, "ok\n", "text/plain; charset=utf-8");
      if (req.method === "POST" && url.pathname === "/verify-signature") return await verifySignature(req, res);
      if (req.method !== "GET" && req.method !== "POST") return send(res, 405, "Method not allowed\n", "text/plain; charset=utf-8");
      return send(res, 404, "Not found\n", "text/plain; charset=utf-8");
    } catch (error) {
      return send(res, 500, `${error.message || error}\n`, "text/plain; charset=utf-8");
    }
  });
}

function listen(port) {
  const server = makeServer();
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && port < START_PORT + 15) return listen(port + 1);
    console.error(error.message || error);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    console.log(`Gate 7 signing helper: http://${HOST}:${port}/`);
    console.log(`Loaded pending typed data from: ${STATE}`);
    console.log("Open the URL in a browser with MetaMask connected to your Ledger.");
  });
}

listen(START_PORT);
