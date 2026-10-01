import { spawn } from "node:child_process";

const port = 4199;
const origin = "http://localhost:3999";
const api = `http://127.0.0.1:${port}`;
const suffix = Date.now().toString(36);
const username = "smoke" + suffix;
const recoveryEmail = username + "@example.test";
const password = "Patra-Smoke-" + suffix + "-Secure";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(path, init = {}) {
  const response = await fetch(api + path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {})
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} failed: ${response.status} ${JSON.stringify(body)}`
    );
  }

  return { response, body };
}

function cookieFrom(response) {
  const raw = response.headers.get("set-cookie") ?? "";
  return raw.split(";")[0];
}

async function waitForGateway(child) {
  const deadline = Date.now() + 20_000;
  let lastError = null;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Gateway exited before smoke test started with code ${child.exitCode}.`);
    }

    try {
      const response = await fetch(api + "/health");
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw lastError ?? new Error("Gateway did not become ready.");
}

const child = spawn(
  process.execPath,
  ["apps/gateway/dist/index.js"],
  {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(port),
      WORKSPACE_GATEWAY_PORT: String(port),
      WORKSPACE_WEB_ORIGIN: origin,
      WORKSPACE_ALLOWED_ORIGINS: origin,
      WORKSPACE_SESSION_COOKIE_PATH: "/",
      WORKSPACE_SESSION_COOKIE_SECURE: "false",
      PATRA_MAIL_DOMAIN: "patra.tamishra.in",
      PATRA_COMPANY_MAIL_DOMAIN: "tamishra.in"
    }
  }
);

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});
child.stdout.on("data", (chunk) => {
  process.stdout.write("[gateway] " + chunk.toString());
});

try {
  await waitForGateway(child);

  const availability = await json(
    "/v1/patra/availability?username=" + encodeURIComponent(username)
  );
  assert(availability.body.available === true, "Smoke username should be available.");
  assert(
    availability.body.address === username + "@patra.tamishra.in",
    "Availability returned the wrong Patra domain."
  );

  const registration = await json("/v1/auth/register", {
    method: "POST",
    headers: { origin },
    body: JSON.stringify({
      email: recoveryEmail,
      password,
      displayName: "Patra Smoke"
    })
  });
  assert(registration.body.authenticated === true, "Registration did not authenticate.");
  let cookie = cookieFrom(registration.response);
  assert(cookie, "Registration did not issue a session cookie.");

  const provision = await json("/v1/patra/mailboxes", {
    method: "POST",
    headers: { origin, cookie },
    body: JSON.stringify({ username })
  });

  const address = provision.body.mailbox?.address;
  assert(
    address === username + "@patra.tamishra.in",
    "Mailbox was not provisioned under patra.tamishra.in."
  );

  await json("/v1/auth/sign-out", {
    method: "POST",
    headers: { origin, cookie }
  });

  const patraLogin = await json("/v1/auth/sign-in", {
    method: "POST",
    headers: { origin },
    body: JSON.stringify({
      email: address,
      password,
      remember: false
    })
  });
  assert(patraLogin.body.authenticated === true, "Patra-address sign-in failed.");
  cookie = cookieFrom(patraLogin.response);
  assert(cookie, "Patra-address sign-in did not issue a session cookie.");

  const mailboxes = await json("/v1/patra/mailboxes", {
    headers: { origin, cookie }
  });
  assert(
    mailboxes.body.mailboxes?.some((mailbox) => mailbox.address === address),
    "Signed-in user cannot access the provisioned Patra mailbox."
  );

  const mailboxId = provision.body.mailbox.id;
  const sent = await json(
    "/v1/patra/mailboxes/" + encodeURIComponent(mailboxId) + "/send",
    {
      method: "POST",
      headers: { origin, cookie },
      body: JSON.stringify({
        to: [address],
        subject: "Patra smoke delivery",
        textBody: "Local delivery smoke test."
      })
    }
  );
  assert(sent.body.delivery === "delivered-locally", "Local Patra delivery did not complete.");

  const inbox = await json(
    "/v1/patra/mailboxes/" +
      encodeURIComponent(mailboxId) +
      "/messages?folder=inbox",
    {
      headers: { origin, cookie }
    }
  );
  assert(
    inbox.body.messages?.some((message) => message.subject === "Patra smoke delivery"),
    "Locally delivered message did not appear in Inbox."
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        flow: [
          "availability",
          "register",
          "provision",
          "sign-out",
          "patra-address-sign-in",
          "mailbox-read",
          "local-send",
          "inbox-receive"
        ],
        domain: "patra.tamishra.in"
      },
      null,
      2
    )
  );
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", resolve);
    setTimeout(resolve, 2000);
  });
}

if (stderr.trim()) {
  process.stderr.write(stderr);
}
