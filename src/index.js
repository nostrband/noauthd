require("websocket-polyfill");
const webpush = require("web-push");
const {
  default: NDK,
  NDKRelaySet,
  NDKRelay,
  NDKPrivateKeySigner,
  NDKNip46Backend,
} = require("@nostr-dev-kit/ndk");
const { createHash } = require("node:crypto");
const express = require("express");
const bodyParser = require("body-parser");
const { nip19, getPublicKey } = require("nostr-tools");
const {
  makePwh2,
  countLeadingZeros,
  getCreateAccountToken,
} = require("./crypto");
const { PrismaClient } = require("@prisma/client");

global.crypto = require("node:crypto");

const prisma = new PrismaClient();

// generate your own keypair with "web-push generate-vapid-keys"
const PUSH_PUBKEY = process.env.PUSH_PUBKEY;
const PUSH_SECKEY = process.env.PUSH_SECRET;
const BUNKER_NSEC = process.env.BUNKER_NSEC;
const BUNKER_RELAY = process.env.BUNKER_RELAY;
const BUNKER_ORIGIN = process.env.BUNKER_ORIGIN;
const BUNKER_DOMAIN = process.env.BUNKER_DOMAIN;

// settings
const port = 8000;
const EMAIL = "artur@nostr.band"; // admin email
const MAX_RELAYS = 3; // no more than 3 relays monitored per pubkey
const MAX_BATCH_SIZE = 500; // pubkeys per sub
const MIN_PAUSE = 5000; // 5 ms
const MAX_PAUSE = 3600000; // 1 hour
const MAX_DATA = 1 << 10; // 1kb
const POW_PERIOD = 3600000; // 1h

// global ndk
const ndk = new NDK({
  enableOutboxModel: false,
  explicitRelayUrls: [BUNKER_RELAY],
});

// set application/json middleware
const app = express();
//app.use(express.json());

// our identity for the push servers
webpush.setVapidDetails(`mailto:${EMAIL}`, PUSH_PUBKEY, PUSH_SECKEY);

// subs - npub:state
const relays = new Map();
const pushSubs = new Map();
const sourcePsubs = new Map();
const relayQueue = [];
const npubData = new Map();
const bunkerTokens = new Map();
const ipNamePows = new Map();

let bunkerSigner = null;

async function push(psub) {
  console.log(
    new Date(),
    "push for",
    psub.pubkey,
    "psub",
    psub.id,
    "pending",
    psub.pendingRequests
  );
  try {
    await webpush.sendNotification(
      psub.pushSubscription,
      JSON.stringify(
        {
          cmd: "wakeup",
          pubkey: psub.pubkey,
        },
        {
          timeout: 3000,
          TTL: 60, // don't store it for too long, it just needs to wakeup
          urgency: "high", // deliver immediately
        }
      )
    );
  } catch (e) {
    console.log(
      new Date(),
      "push failed for",
      psub.pubkey,
      "code",
      e.statusCode,
      "headers",
      e.headers
    );

    // reset
    psub.lastPush = 0;

    switch (e.statusCode) {
      // 429	Too many requests. Meaning your application server has reached a rate limit with a push service. The push service should include a 'Retry-After' header to indicate how long before another request can be made.
      case 429:
        // FIXME mark psub as 'quite' until Retry-After
        // FIXME use psub.lastPush for Retry-After
        break;
      // 400	Invalid request. This generally means one of your headers is invalid or improperly formatted.
      case 400:
      // 413	Payload size too large. The minimum size payload a push service must support is 4096 bytes (or 4kb).
      case 413:
        // WTF?
        break;
      // 404	Not Found. This is an indication that the subscription is expired and can't be used. In this case you should delete the `PushSubscription` and wait for the client to resubscribe the user.
      case 400:
      // 410	Gone. The subscription is no longer valid and should be removed from application server. This can be reproduced by calling `unsubscribe()` on a `PushSubscription`.
      case 410:
        // it's gone!
        return false;
    }
  }

  psub.lastPush = Date.now();
  return true;
}

function clearTimer(psub) {
  if (psub.timer) {
    clearTimeout(psub.timer);
    psub.timer = undefined;
  }
}

function restartTimer(psub) {
  if (psub.timer) clearTimeout(psub.timer);

  const passed = Date.now() - psub.lastPush;

  // backoff
  let pause = psub.backoffMs ? psub.backoffMs : MIN_PAUSE;

  // crop max backoff
  pause = Math.min(pause, MAX_PAUSE);

  // exclude the time we've already been silent,
  // but leave MIN_PAUSE for a normal reply!
  pause = Math.max(pause - passed, MIN_PAUSE);

  psub.timer = setTimeout(async () => {
    psub.timer = undefined;
    if (psub.pendingRequests > 0) {
      const ok = await push(psub);
      if (!ok) {
        // drop this psub!
        unsubscribe(psub);
      }

      // logarithmic backoff to make sure
      // we don't spam the push server if there is
      // a dead signer
      psub.backoffMs = (psub.backoffMs || MIN_PAUSE) * 2;
    }

    // clear
    psub.pendingRequests = 0;
  }, pause);
}

function getP(e) {
  return e.tags.find((t) => t.length > 1 && t[0] === "p")?.[1];
}

function processRequest(r, e) {
  // ignore old requests in case relay sends them for some reason
  if (e.created_at < Date.now() / 1000 - 10) return;

  const pubkey = getP(e);
  const pr = pubkey + r.url;
  const psubs = sourcePsubs.get(pr);
  console.log(new Date(), "request for", pubkey, "at", r.url, "subs", psubs);
  for (const id of psubs) {
    const psub = pushSubs.get(id);
    // start timer on first request
    if (!psub.pendingRequests) restartTimer(psub);
    psub.pendingRequests++;
  }
}

function processReply(r, e) {
  const pubkey = e.pubkey;
  console.log(new Date(), "reply from", pubkey, "on", r.url);

  const pr = pubkey + r.url;
  const psubs = sourcePsubs.get(pr);
  if (!psubs) {
    console.log("skip unknown reply from", pubkey);
    return;
  }
  for (const id of psubs) {
    const psub = pushSubs.get(id);

    if (!psub.pendingRequests) {
      console.log("skip unexpected reply from", pubkey);
      continue;
    }
    psub.pendingRequests--;
    psub.backoffMs = 0; // reset backoff period

    if (psub.pendingRequests > 0) {
      // got more pending? ok move the timer
      restartTimer(psub);
    } else {
      // no more pending? clear
      clearTimer(psub);
    }
  }
}

function unsubscribeFromRelay(psub, relayUrl) {
  console.log(
    "unsubscribeunsubscribeFromRelay",
    psub.id,
    psub.pubkey,
    "from",
    relayUrl
  );

  // remove from global pubkey+relay=psub table
  const pr = psub.pubkey + relayUrl;
  const psubs = sourcePsubs.get(pr).filter((pi) => pi != psub.id);
  if (psubs.length > 0) {
    // still some other psub uses the same pubkey on this relay
    sourcePsubs.set(pr, psubs);
  } else {
    // this pubkey is no longer on this relay
    const relay = relays.get(relayUrl);
    relay.unsubQueue.push(psub.pubkey);
    relayQueue.push(relayUrl);

    sourcePsubs.delete(pr);
  }
}

function unsubscribe(psub) {
  console.log("unsubscribe", psub.id, psub.pubkey);

  for (const url of psub.relays) unsubscribeFromRelay(psub, url);

  pushSubs.delete(psub.id);

  // drop from db
  prisma.pushSubs
    .delete({
      where: { pushId: psub.id },
    })
    .then((r) => console.log("deleted psub", psub.id, r));
}

function subscribe(psub, relayUrls) {
  const pubkey = psub.pubkey;
  const oldRelays = psub.relays.filter((r) => !relayUrls.includes(r));
  const newRelays = relayUrls.filter((r) => !psub.relays.includes(r));

  console.log({ oldRelays, newRelays });

  // store
  psub.relays = relayUrls;

  for (const url of oldRelays) unsubscribeFromRelay(psub, url);

  for (const url of newRelays) {
    let relay = relays.get(url);
    if (!relay) {
      relay = {
        url,
        unsubQueue: [],
        subQueue: [],
        subs: new Map(),
        pubkeySubs: new Map(),
      };
      relays.set(url, relay);
    }
    relay.subQueue.push(pubkey);
    relayQueue.push(url);

    // add to global pubkey+relay=psub table
    const pr = pubkey + relay.url;
    const psubs = sourcePsubs.get(pr) || [];
    psubs.push(psub.id);
    sourcePsubs.set(pr, psubs);
  }
}

function ensureRelay(url) {
  if (ndk.pool.relays.get(url)) return;

  const ndkRelay = new NDKRelay(url);
  let first = true;
  ndkRelay.on("connect", () => {
    if (first) {
      first = false;
      return;
    }

    // retry all existing subs
    console.log(new Date(), "resubscribing to relay", url);
    const r = relays.get(url);
    for (const pubkey of r.pubkeySubs.keys()) {
      r.unsubQueue.push(pubkey);
      r.subQueue.push(pubkey);
    }
    relayQueue.push(url);
  });

  ndk.pool.addRelay(ndkRelay);
}

function createPubkeySub(r) {
  ensureRelay(r.url);

  const batchSize = Math.min(r.subQueue.length, MAX_BATCH_SIZE);
  const pubkeys = [...new Set(r.subQueue.splice(0, batchSize))];

  const since = Math.floor(Date.now() / 1000) - 10;
  const requestFilter = {
    kinds: [24133],
    "#p": pubkeys,
    // older requests have likely expired
    since,
  };
  const replyFilter = {
    kinds: [24133],
    authors: pubkeys,
    since,
  };

  const sub = ndk.subscribe(
    [requestFilter, replyFilter],
    {
      closeOnEose: false,
      subId: `pubkeys_${Date.now()}_${pubkeys.length}`,
    },
    NDKRelaySet.fromRelayUrls([r.url], ndk),
    /* autoStart */ false
  );
  sub.on("event", (e) => {
    // console.log("event by ", e.pubkey, "to", getP(e));
    try {
      if (pubkeys.includes(e.pubkey)) {
        processReply(r, e);
      } else {
        processRequest(r, e);
      }
    } catch (err) {
      console.log("error", err);
    }
  });
  sub.start();

  // set sub pubkeys
  sub.pubkeys = pubkeys;

  return sub;
}

function processRelayQueue() {
  const closeQueue = [];

  // take queue, clear it
  const uniqRelays = new Set(relayQueue);
  relayQueue.length = 0;
  if (uniqRelays.size > 0) console.log({ uniqRelays });

  // process active relay queue
  for (const url of uniqRelays.values()) {
    const r = relays.get(url);
    console.log(
      new Date(),
      "update relay",
      url,
      "sub",
      r.subQueue.length,
      "unsub",
      r.unsubQueue.length
    );

    // first handle the unsubs
    for (const p of new Set(r.unsubQueue).values()) {
      // a NDK sub id matching this pubkey on this relay
      const subId = r.pubkeySubs.get(p);
      // unmap pubkey from NDK sub id
      r.pubkeySubs.delete(p);
      // get the NDK sub by id
      const sub = r.subs.get(subId);
      // put back all NDK sub's pubkeys except the removed ones
      r.subQueue.push(
        ...sub.pubkeys.filter((sp) => !r.unsubQueue.includes(sp))
      );
      // mark this sub for closure
      closeQueue.push(sub);
      // delete sub from relay's store,
      // it's now owned by the closeQueue
      r.subs.delete(subId);
    }
    // clear the queue
    r.unsubQueue = [];

    // now create new NDK subs for new pubkeys and for old
    // pubkeys from updated subs
    r.subQueue = [...new Set(r.subQueue).values()];
    while (r.subQueue.length > 0) {
      // create NDK sub for the next batch of pubkeys
      // from subQueue, and remove those pubkeys from subQueue
      const sub = createPubkeySub(r);

      // map sub's pubkeys to subId
      for (const p of sub.pubkeys) r.pubkeySubs.set(p, sub.subId);

      // store NDK sub itself
      r.subs.set(sub.subId, sub);
    }
  }

  // close old subs after new subs have activated
  setTimeout(() => {
    for (const sub of closeQueue) {
      sub.stop();
      console.log(new Date(), "closing sub", sub.subId);
    }
  }, 500);

  // schedule the next processing
  setTimeout(processRelayQueue, 1000);
}

// schedule the next processing
setTimeout(processRelayQueue, 1000);

function digest(algo, data) {
  const hash = createHash(algo);
  hash.update(data);
  return hash.digest("hex");
}

function isValidName(name) {
  const REGEX = /^[a-z0-9_]{3,128}$/;
  return REGEX.test(name);
}

function getIp(req) {
  return req.header("x-real-ip") || req.ip;
}

function getMinPow(name, req) {
  let minPow = 14;
  if (name.length <= 5) {
    minPow += 3;
  }

  const ip = getIp(req);

  // have a record for this ip?
  let { pow: lastPow = 0, tm = 0 } = ipNamePows.get(ip) || {};
  console.log("minPow", { name, ip, lastPow, tm, headers: req.headers });
  if (lastPow) {
    // refill: reduce the pow threshold once per passed period
    const age = Date.now() - tm;
    const refill = Math.floor(age / POW_PERIOD);
    lastPow -= refill;
  }

  // if have lastPow - increment it and return
  if (lastPow && lastPow >= minPow) {
    minPow = lastPow + 1;
  }

  return minPow;
}

// nip98
async function verifyAuthNostr(req, npub, path, minPow = 0) {
  try {
    const { type, data: pubkey } = nip19.decode(npub);
    if (type !== "npub") return false;

    const { authorization } = req.headers;
    //console.log("req authorization", pubkey, authorization);
    if (!authorization.startsWith("Nostr ")) return false;
    const data = authorization.split(" ")[1].trim();
    if (!data) return false;

    const json = atob(data);
    const event = JSON.parse(json);
    // console.log("req authorization event", event);

    const now = Math.floor(Date.now() / 1000);
    if (event.pubkey !== pubkey) return false;
    if (event.kind !== 27235) return false;
    if (event.created_at < now - 60 || event.created_at > now + 60)
      return false;

    const pow = countLeadingZeros(event.id);
    console.log("pow", pow, "min", minPow, "id", event.id);
    if (minPow && pow < minPow) return false;

    const u = event.tags.find((t) => t.length === 2 && t[0] === "u")?.[1];
    const method = event.tags.find(
      (t) => t.length === 2 && t[0] === "method"
    )?.[1];
    const payload = event.tags.find(
      (t) => t.length === 2 && t[0] === "payload"
    )?.[1];
    if (method !== req.method) return false;

    const url = new URL(u);
    // console.log({ url })
    if (url.origin !== process.env.ORIGIN || url.pathname !== path)
      return false;

    if (req.rawBody.length > 0) {
      const hash = digest("sha256", req.rawBody.toString());
      // console.log({ hash, payload, body: req.rawBody.toString() })
      if (hash !== payload) return false;
    } else if (payload) {
      return false;
    }

    return true;
  } catch (e) {
    console.log("auth error", e);
    return false;
  }
}

async function addPsub(id, pubkey, pushSubscription, relays) {
  let psub = pushSubs.get(id);
  if (psub) {
    psub.pushSubscription = pushSubscription;
    console.log(new Date(), "sub updated", pubkey, psub, relays);
  } else {
    // new sub for this id
    psub = {
      id,
      pubkey,
      pushSubscription,
      relays: [],
      pendingRequests: 0,
      timer: undefined,
      backoffMs: 0,
      lastPush: 0,
    };

    console.log(new Date(), "sub created", pubkey, psub, relays);
  }

  // update relaySubs if needed
  subscribe(psub, relays);

  // update
  pushSubs.set(id, psub);
}

// json middleware that saves the original body for nip98 auth
app.use(
  bodyParser.json({
    verify: function (req, res, buf, encoding) {
      req.rawBody = buf;
    },
  })
);

// CORS headers
app.use(function (req, res, next) {
  res
    .header("Access-Control-Allow-Origin", "*")
    .header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
    .header(
      "Access-Control-Allow-Headers",
      "accept,content-type,x-requested-with,authorization"
    );
  next();
});

const SUBSCRIBE_PATH = "/subscribe";
app.post(SUBSCRIBE_PATH, async (req, res) => {
  try {
    const { npub, pushSubscription, relays } = req.body;

    if (!(await verifyAuthNostr(req, npub, SUBSCRIBE_PATH))) {
      console.log("auth failed", npub);
      res.status(403).send({
        error: `Bad auth`,
      });
      return;
    }

    if (relays.length > MAX_RELAYS) {
      console.log("too many relays", relays.length);
      res.status(400).send({
        error: `Too many relays, max ${MAX_RELAYS}`,
      });
      return;
    }

    const { data: pubkey } = nip19.decode(npub);
    const id = digest("sha1", pubkey + pushSubscription.endpoint);

    await addPsub(id, pubkey, pushSubscription, relays);

    // write to db w/o blocking the client
    prisma.pushSubs
      .upsert({
        where: { pushId: id },
        create: {
          pushId: id,
          npub,
          pushSubscription: JSON.stringify(pushSubscription),
          relays: JSON.stringify(relays),
          timestamp: Date.now(),
        },
        update: {
          pushSubscription: JSON.stringify(pushSubscription),
          relays: JSON.stringify(relays),
          timestamp: Date.now(),
        },
      })
      .then((dbr) => console.log({ dbr }));

    // reply ok
    res.status(201).send({
      ok: true,
    });
  } catch (e) {
    console.log(new Date(), "error req from ", req.ip, e.toString());
    res.status(400).send({
      error: "Internal error",
    });
  }
});

const PUT_PATH = "/put";
app.post(PUT_PATH, async (req, res) => {
  try {
    const { npub, data, pwh } = req.body;

    if (!(await verifyAuthNostr(req, npub, PUT_PATH))) {
      console.log("auth failed", npub);
      res.status(403).send({
        error: `Bad auth`,
      });
      return;
    }

    if (data.length > MAX_DATA || pwh.length > MAX_DATA) {
      console.log("data too long");
      res.status(400).send({
        error: `Data too long, max ${MAX_DATA}`,
      });
      return;
    }

    const start = Date.now();
    const { pwh2, salt } = await makePwh2(pwh);
    console.log(
      new Date(),
      "put",
      npub,
      data,
      pwh2,
      salt,
      "in",
      Date.now() - start,
      "ms"
    );
    npubData.set(npub, { data, pwh2, salt });

    // write to db w/o blocking the client
    prisma.npubData
      .upsert({
        where: { npub },
        create: {
          npub,
          data,
          pwh2,
          salt,
          timestamp: Date.now(),
        },
        update: {
          data,
          pwh2,
          salt,
          timestamp: Date.now(),
        },
      })
      .then((dbr) => console.log({ dbr }));

    // reply ok
    res.status(201).send({
      ok: true,
    });
  } catch (e) {
    console.log(new Date(), "error req from ", req.ip, e.toString());
    res.status(400).send({
      error: "Internal error",
    });
  }
});

const GET_PATH = "/get";
app.post(GET_PATH, async (req, res) => {
  try {
    const { npub, pwh } = req.body;

    const { type } = nip19.decode(npub);
    if (type !== "npub") {
      console.log("bad npub", npub);
      res.status(400).send({
        error: "Bad npub",
      });
      return;
    }

    const d = npubData.get(npub);
    if (!d) {
      console.log("no data for npub", npub);
      res.status(404).send({
        error: "Not found",
      });
      return;
    }

    const start = Date.now();
    const { pwh2 } = await makePwh2(pwh, Buffer.from(d.salt, "hex"));
    console.log(
      new Date(),
      "get",
      npub,
      pwh2,
      d.salt,
      "in",
      Date.now() - start,
      "ms"
    );

    if (d.pwh2 !== pwh2) {
      console.log("bad pwh npub", npub);
      res.status(403).send({
        error: "Forbidden",
      });
      return;
    }

    console.log(new Date(), "get", npub, d.data);

    // reply ok
    res.status(200).send({
      data: d.data,
    });
  } catch (e) {
    console.log(new Date(), "error req from ", req.ip, e.toString());
    res.status(400).send({
      error: "Internal error",
    });
  }
});

const NAME_PATH = "/name";
app.post(NAME_PATH, async (req, res) => {
  try {
    const { npub, name } = req.body;

    if (!isValidName(name)) {
      console.log("invalid name", name);
      res.status(400).send({
        error: `Bad name`,
      });
      return;
    }

    const { type } = nip19.decode(npub);
    if (type !== "npub") {
      console.log("bad npub", npub);
      res.status(400).send({
        error: "Bad npub",
      });
      return;
    }

    const minPow = getMinPow(name, req);

    if (!(await verifyAuthNostr(req, npub, NAME_PATH, minPow))) {
      console.log("auth failed", npub);
      res.status(403).send({
        error: `Bad auth`,
        minPow,
      });
      return;
    }

    const names = await prisma.names.findMany({
      where: {
        npub,
        name,
      },
    });
    const alreadyAssigned = names.find((n) => n.name === name);
    if (alreadyAssigned) {
      console.log("Name", name, "already assigned to", npub);
      // reply ok
      res.status(200).send({
        ok: true,
      });
      return;
    }

    try {
      const dbr = await prisma.names.create({
        data: {
          npub,
          name,
          timestamp: Date.now(),
        },
      });
      console.log({ dbr });
    } catch (e) {
      res.status(400).send({
        error: "Name taken",
      });
      return;
    }

    // update minPow for this ip
    ipNamePows.set(getIp(req), { pow: minPow, tm: Date.now() });

    // reply ok
    res.status(201).send({
      ok: true,
    });
  } catch (e) {
    console.log(new Date(), "error req from ", req.ip, e.toString());
    res.status(500).send({
      error: "Internal error",
    });
  }
});

app.get(NAME_PATH, async (req, res) => {
  try {
    const { npub } = req.query;
    if (!npub) {
      res.status(400).send({ error: "Specify npub" });
      return;
    }

    const recs = await prisma.names.findMany({
      where: {
        npub,
      },
    });
    console.log("npub", npub, recs);

    const data = {
      names: recs.map((r) => r.name),
    };

    res.status(200).send(data);
  } catch (e) {
    console.log(new Date(), "error req from ", req.ip, e.toString());
    res.status(500).send({
      error: "Internal error",
    });
  }
});

const JSON_PATH = "/.well-known/nostr.json";
app.get(JSON_PATH, async (req, res) => {
  try {
    const { data: bunkerNsec } = nip19.decode(BUNKER_NSEC);
    const bunkerPubkey = getPublicKey(bunkerNsec);

    const data = {
      names: {
        _: bunkerPubkey,
      },
      nip46: {},
    };
    data.nip46[bunkerPubkey] = [BUNKER_RELAY];

    const { name } = req.query;
    if (!name) {
      res.status(200).send(data);
      return;
    }

    const rec = await prisma.names.findUnique({
      where: {
        name,
      },
    });
    console.log("name", name, rec);

    if (rec) {
      const { data: pubkey } = nip19.decode(rec.npub);
      data.names[rec.name] = pubkey;
    }

    res.status(200).send(data);
  } catch (e) {
    console.log(new Date(), "error req from ", req.ip, e.toString());
    res.status(500).send({
      error: "Internal error",
    });
  }
});

const CREATED_PATH = "/created";
app.post(CREATED_PATH, async (req, res) => {
  try {
    const { npub, token } = req.body;

    const { type, data: pubkey } = nip19.decode(npub);
    if (type !== "npub") {
      console.log("bad npub", npub);
      res.status(400).send({
        error: "Bad npub",
      });
      return;
    }

    const cb = bunkerTokens.get(token);
    if (!cb) {
      console.log("bad token", token, npub);
      res.status(400).send({
        error: "Bad token",
      });
      return;
    }

    if (!(await verifyAuthNostr(req, npub, CREATED_PATH))) {
      console.log("auth failed", npub);
      res.status(403).send({
        error: `Bad auth`,
        minPow,
      });
      return;
    }

    // redeem
    bunkerTokens.delete(token);

    // if cb throws we will inform the client
    // that they should connect to the app manually
    await cb(pubkey);

    // reply ok
    res.status(200).send({
      ok: true,
    });
  } catch (e) {
    console.log(new Date(), "error req from ", req.ip, e.toString());
    res.status(500).send({
      error: "Internal error",
    });
  }
});

async function loadFromDb() {
  const start = Date.now();

  const psubs = await prisma.pushSubs.findMany();
  for (const ps of psubs) {
    const { type, data: pubkey } = nip19.decode(ps.npub);
    if (type !== "npub") continue;
    try {
      await addPsub(
        ps.pushId,
        pubkey,
        JSON.parse(ps.pushSubscription),
        JSON.parse(ps.relays)
      );
    } catch (e) {
      console.log("load error", e);
    }
  }

  const datas = await prisma.npubData.findMany();
  for (const d of datas) {
    npubData.set(d.npub, {
      data: d.data,
      pwh2: d.pwh2,
      salt: d.salt,
    });
  }

  console.log(
    "loaded from db in",
    Date.now() - start,
    "ms psubs",
    psubs.length,
    "datas",
    datas.length
  );
}

class CreateAccountHandlingStrategy {
  constructor() {}

  async handle(backend, id, remotePubkey, params) {
    // generate token
    const token = getCreateAccountToken();

    // params
    const [name = "", domain = ""] = params;

    if (domain !== BUNKER_DOMAIN) throw new Error("Bad domain");

    const appNpub = nip19.npubEncode(remotePubkey);

    // format auth url
    const url = `${BUNKER_ORIGIN}/create?name=${name}&token=${token}&appNpub=${appNpub}`;
    console.log("sending auth_url", url, "to", remotePubkey);
    await backend.rpc.sendResponse(
      id,
      remotePubkey,
      "auth_url",
      undefined,
      url
    );

    // wait for token redeemal
    const tokenPromise = new Promise((ok) => {
      // will resolve if app redeems the token
      bunkerTokens.set(token, ok);
    });

    // timeout to avoid
    const timeoutPromise = new Promise((_, err) =>
      setTimeout(() => {
        // release memory
        bunkerTokens.delete(token);

        // throw
        err("Timeout");
      }, 3600000)
    );

    // if tokenPromise resolves it returns the new pubkey
    return await Promise.race([tokenPromise, timeoutPromise]);
  }
}

async function startBunker() {
  const { data: bunkerSk } = nip19.decode(BUNKER_NSEC);
  bunkerSigner = new NDKNip46Backend(
    ndk,
    new NDKPrivateKeySigner(bunkerSk),
    () => true
  );
  bunkerSigner.handlers = {
    create_account: new CreateAccountHandlingStrategy(),
  };
  bunkerSigner.start();
  console.log("starting bunker");
}

console.log(process.argv);
if (process.argv.length >= 3) {
  if (process.argv[2] === "list_names") {
    prisma.names.findMany().then((names) => {
      for (const n of names) console.log(n.id, n.name, n.npub, n.timestamp);
    });
    return;
  } else if (process.argv[2] === "delete_name") {
    if (process.argv.length < 4) {
      console.log("enter name");
      return;
    }
    const name = process.argv[3];
    prisma.names.delete({ where: { name } }).then((r) => {
      console.log("deleted", name, r);
    });
    return;
  }
}

// start bunker
ndk.connect().then(startBunker);

// start server
loadFromDb().then(() => {
  app.listen(port, () => {
    console.log(`Listening on port ${port}!`);
  });
});
