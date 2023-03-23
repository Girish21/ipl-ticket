/**
 * Welcome to Cloudflare Workers! This is your first scheduled worker.
 *
 * - Run `wrangler dev --local` in your terminal to start a development server
 * - Run `curl "http://localhost:8787/cdn-cgi/mf/scheduled"` to trigger the scheduled event
 * - Go back to the console to see what your worker has logged
 * - Update the Cron trigger in wrangler.toml (see https://developers.cloudflare.com/workers/wrangler/configuration/#triggers)
 * - Run `wrangler publish --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/runtime-apis/scheduled-event/
 */

export interface Env {
  TO_PHONENUMBER: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  // Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
  KV_MATCHES: KVNamespace;
  //
  // Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
  // MY_DURABLE_OBJECT: DurableObjectNamespace;
  //
  // Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
  // MY_BUCKET: R2Bucket;
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(parseAndSendSMS(env));
  },
};

async function consume(stream: ReadableStream) {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    /* NOOP */
  }
}

async function parseAndSendSMS(env: Env) {
  console.log("fetching insider.in");

  try {
    let response = await fetch(
      "https://insider.in/search?q=chennai%20super%20kings"
    );
    if (!response.ok) {
      console.log("error fetching insider.in", await response.text());
      return;
    }

    let matches: Array<Match> = [];

    let rewritter = new HTMLRewriter().on('[data-ref="event_card_title"]', {
      async text(element) {
        let text = element.text?.trim();
        if (!text) {
          return;
        }

        let eventRegex =
          /(?:.+)?([mM]atch \d+)(?:.+)?[-|]\s([\w ]+) ?vs ?([\w ]+)/gi;

        let [, match, homeTeam, awayTeam] = eventRegex.exec(text) || [];
        if (!match || !homeTeam || !awayTeam) {
          console.log("match not found", text);
          return;
        }

        let matchTextEncode = new TextEncoder().encode(
          `${homeTeam} ${awayTeam}`
        );
        let digest = await crypto.subtle.digest(
          { name: "md5" },
          matchTextEncode
        );

        matches.push({
          match: match.trim(),
          homeTeam: homeTeam.trim(),
          awayTeam: awayTeam.trim(),
          hash: Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
        });
      },
    });

    consume(rewritter.transform(response).body!).then(async () => {
      let newMatch: Match | undefined;
      for (let match of matches) {
        if (await env.KV_MATCHES.get(match.hash)) {
          continue;
        }

        newMatch = match;
        await env.KV_MATCHES.put(match.hash, JSON.stringify(match));
        break;
      }

      if (!newMatch) {
        console.log("No new match found");
        return;
      }

      console.log("sending sms", newMatch);

      let response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
        {
          method: "POST",
          body: new URLSearchParams([
            [
              "Body",
              `${newMatch.homeTeam} vs ${newMatch.awayTeam} bookings have started!`,
            ],
            ["From", "+14754739746"],
            ["To", env.TO_PHONENUMBER],
          ]),
          headers: {
            Authorization:
              "Basic " +
              btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );
      if (!response.ok) {
        console.error("error sending sms", await response.text());
        return;
      }
      console.log("sms sent");
    });
  } catch (e) {
    console.log(e);
  }
}

type Match = {
  match: string;
  homeTeam: string;
  awayTeam: string;
  hash: string;
};
