require("websocket-polyfill");
const {
  default: NDK,
  NDKEvent,
  NDKPrivateKeySigner,
  NDKNip46Signer,
} = require("@nostr-dev-kit/ndk");
const { createHash } = require("node:crypto");
const { nip19, getPublicKey, generatePrivateKey } = require("nostr-tools");

global.crypto = require("node:crypto");

const ndk = new NDK({
  enableOutboxModel: false,
  explicitRelayUrls: ["wss://relay.nsec.app"],
});

const LOCAL = true;
const BUNKER_PUBKEY = LOCAL
  ? "44f9def756f8575aed604408a5c8f5a09d01633015fc65894fdd12af77457f3a"
  : "e24a86943d37a91ab485d6f9a7c66097c25ddd67e8bd1b75ed252a3c266cf9bb";

const sk = generatePrivateKey();
console.log("test pubkey", getPublicKey(sk));
const signer = new NDKNip46Signer(
  ndk,
  BUNKER_PUBKEY,
  new NDKPrivateKeySigner(sk)
);

async function sendPost({ url, method, headers, body }) {
  console.log("sendPost", url, headers, body);
  const r = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body,
  });
  if (r.status !== 200 && r.status !== 201) {
    console.log("Fetch error", url, method, r.status);
    const body = await r.json();
    throw new Error("Failed to fetch " + url, { cause: body });
  }

  return await r.json();
}

function sha256(data) {
  return createHash("sha256").update(data, "utf8").digest().toString("hex");
}

function countLeadingZeros(hex) {
  let count = 0

  for (let i = 0; i < hex.length; i++) {
    const nibble = parseInt(hex[i], 16)
    if (nibble === 0) {
      count += 4
    } else {
      count += Math.clz32(nibble) - 28
      break
    }
  }

  return count
}

function minePow(e, target) {
  let ctr = 0

  let nonceTagIdx = e.tags.findIndex((a) => a[0] === 'nonce')
  if (nonceTagIdx === -1) {
    nonceTagIdx = e.tags.length
    e.tags.push(['nonce', ctr.toString(), target.toString()])
  }
  do {
    e.tags[nonceTagIdx][1] = (++ctr).toString()
    e.id = createId(e)
  } while (countLeadingZeros(e.id) < target)

  return e
}

function createId(e) {
  const payload = [0, e.pubkey, e.created_at, e.kind, e.tags, e.content]
  return sha256(JSON.stringify(payload))
}

async function sendPostAuthd({
  sk,
  url,
  method = 'GET',
  body = '',
  pow = 0,
}) {
  const pubkey = getPublicKey(sk);
  const signer = new NDKPrivateKeySigner(sk);

  const authEvent = new NDKEvent(ndk, {
    pubkey: pubkey,
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['u', url],
      ['method', method],
    ],
  })
  if (body) authEvent.tags.push(['payload', await sha256(body)])

  // generate pow on auth evevnt
  if (pow) {
    const start = Date.now()
    const powEvent = authEvent.rawEvent()
    const minedEvent = minePow(powEvent, pow)
    console.log('mined pow of', pow, 'in', Date.now() - start, 'ms', minedEvent)
    authEvent.tags = minedEvent.tags
  }

  authEvent.sig = await authEvent.sign(signer);

  const auth = Buffer.from(JSON.stringify(authEvent.rawEvent())).toString(
    "base64"
  );

  return await sendPost({
    url,
    method,
    headers: {
      Authorization: `Nostr ${auth}`,
    },
    body,
  })
}

// OAuth flow
signer.on("authUrl", async (url) => {
  console.log("nostr login auth url", url);
  const u = new URL(url);
  const token = u.searchParams.get("token");
  console.log({ token });
  const sk = generatePrivateKey();
  console.log("created account", getPublicKey(sk));
  await sendPostAuthd({
    sk,
    method: "POST",
    url: LOCAL
      ? "http://localhost:8000/created"
      : "https://noauthd.nsec.app/created",
    body: JSON.stringify({
      npub: nip19.npubEncode(getPublicKey(sk)),
      token,
    }),
  });
});

if (process.argv.length >= 3) {
  if (process.argv[2] === "check_names") {
    const sk = generatePrivateKey();
    const npub = nip19.npubEncode(getPublicKey(sk))
    const sk1 = generatePrivateKey();
    const npub1 = nip19.npubEncode(getPublicKey(sk1))
    const name = npub.substring(0, 10);
    console.log("create name", npub, name);
    const test = async () => {
      await sendPostAuthd({
        sk,
        method: "POST",
        url: LOCAL
          ? "http://localhost:8000/name"
          : "https://noauthd.nsec.app/name",
        body: JSON.stringify({
          npub,
          name,
        }),
        pow: 15
      });
      console.log("created");
      await sendPostAuthd({
        sk,
        method: "PUT",
        url: LOCAL
          ? "http://localhost:8000/name"
          : "https://noauthd.nsec.app/name",
        body: JSON.stringify({
          npub,
          name: name,
          newNpub: npub1
        }),
      });
      console.log("transferred")
      await sendPostAuthd({
        sk: sk1,
        method: "POST",
        url: LOCAL
          ? "http://localhost:8000/name"
          : "https://noauthd.nsec.app/name",
        body: JSON.stringify({
          npub: npub1,
          name,
        }),
        pow: 16
      });
      // await sendPostAuthd({
      //   sk: sk1,
      //   method: "DELETE",
      //   url: LOCAL
      //     ? "http://localhost:8000/name"
      //     : "https://noauthd.nsec.app/name",
      //   body: JSON.stringify({
      //     npub: npub1,
      //     name: name,
      //   }),
      // });
      // console.log("deleted");
    }
    test()
  }
} else {
  const params = [
    "test",
    "nsec.app",
    // email?
  ];
  ndk
    .connect()
    .then(async () => {
      console.log("sending", params);
      signer.rpc.sendRequest(
        BUNKER_PUBKEY,
        "create_account",
        params,
        undefined,
        (res) => {
          console.log({ res });
        }
      );
    })
    .then(console.log);
}
