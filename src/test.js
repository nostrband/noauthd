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

const BUNKER_PUBKEY =
  "44f9def756f8575aed604408a5c8f5a09d01633015fc65894fdd12af77457f3a";

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
      'Content-Type': 'application/json',
      ...headers,
    },
    body,
  })
  if (r.status !== 200 && r.status !== 201) {
    console.log('Fetch error', url, method, r.status)
    const body = await r.json()
    throw new Error('Failed to fetch ' + url, { cause: body })
  }

  return await r.json()
}

async function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest().toString('hex')
} 

async function sendPostAuthd({
  sk,
  url,
  method = 'GET',
  body = ''
}) {

  const pubkey = getPublicKey(sk)
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

  authEvent.sig = await authEvent.sign(signer)

  const auth = Buffer.from(JSON.stringify(authEvent.rawEvent())).toString('base64')

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
  const token = u.searchParams.get('token');
  console.log({ token });
  const sk = generatePrivateKey();
  console.log("created account", getPublicKey(sk));
  await sendPostAuthd({ 
    sk, 
    method: 'POST',
    url: 'http://localhost:8000/created',
    body: JSON.stringify({
      npub: nip19.npubEncode(getPublicKey(sk)),
      token,
    })
  })
});

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
      BUNKER_PUBKEY, "create_account", params, undefined,
      (res) => {
        console.log({ res });
      });
  })
  .then(console.log);
