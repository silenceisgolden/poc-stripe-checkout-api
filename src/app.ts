import 'dotenv/config';
import * as Koa from 'koa';
import * as bodyparser from 'koa-bodyparser';
import * as Router from '@koa/router';
import * as cors from '@koa/cors';
import * as Stripe from 'stripe';
import * as Debug from 'debug';

import ICheckoutCreationOptions = Stripe.checkouts.sessions.ICheckoutCreationOptions;
import ISubscriptionUpdateOptions = Stripe.subscriptions.ISubscriptionUpdateOptions;
import ISubscriptionListOptions = Stripe.subscriptions.ISubscriptionListOptions;

const THREE_DAY = (1000 * 60 * 60 * 24 * 3) + 5000;

const debug = Debug('poc:app');

const STRIPE_KEY = process.env.STRIPE_KEY || '';
const STRIPE_PLAN = process.env.STRIPE_PLAN_ID || '';
const CLIENT_DOMAIN = process.env.CLIENT_DOMAIN || '';
const STRIPE_CUSTOMER_ID = process.env.STRIPE_CUSTOMER_ID || '';

const stripe = new Stripe(STRIPE_KEY);

const app = new Koa();
const router = new Router();

// routes
router.post('/subscriptions/session-create', async (ctx) => {
  const sessionCreateOptions: ICheckoutCreationOptions = {
    customer: STRIPE_CUSTOMER_ID,
    payment_method_types: ['card'],
    subscription_data: {
      items: [
        {
          plan: STRIPE_PLAN
        }
      ],
      trial_end: Math.floor((Date.now() + THREE_DAY) / 1000),
      metadata: {
        trial: 'auto'
      }
    },
    success_url: `${CLIENT_DOMAIN}/success`,
    cancel_url: `${CLIENT_DOMAIN}/cancel`
  };

  debug(sessionCreateOptions);

  const session = await stripe.checkout.sessions.create(sessionCreateOptions);

  debug(session);

  ctx.body = {
    id: session.id
  };
  ctx.status = 200;
});

router.post('/subscriptions/session-update', async (ctx) => {
  const customer = await stripe.customers.retrieve(STRIPE_CUSTOMER_ID);

  // I could not find how the subscriptions are sorted by default in the docs, so sort them just to be safe
  // Also, are canceled subscriptions retrieved as a part of the default customer object?
  const sortedSubscriptions = customer.subscriptions.data.sort((a, b) => {
    return a.created < b.created ? -1 : 1;
  });

  debug(sortedSubscriptions);

  // Get the newest subscription which should be active
  const mostRecentSubscription = sortedSubscriptions[0];

  const sessionUpdateOptions: ICheckoutCreationOptions = {
    customer: STRIPE_CUSTOMER_ID,
    payment_method_types: ['card'],
    subscription_data: {
      items: [
        {
          plan: STRIPE_PLAN
        }
      ],
      metadata: {
        trial: 'full'
      }
    },
    success_url: `${CLIENT_DOMAIN}/success`,
    cancel_url: `${CLIENT_DOMAIN}/cancel`
  };

  // map that trial end to the new subscription that will be created
  if (mostRecentSubscription.trial_end) {
    sessionUpdateOptions.subscription_data!.trial_end = mostRecentSubscription.trial_end;
  }

  debug(sessionUpdateOptions);

  const session = await stripe.checkout.sessions.create(sessionUpdateOptions);

  debug(session);

  ctx.body = {
    id: session.id
  };
  ctx.status = 200;
});

router.post('/webhook/subscription-complete', async (ctx) => {
  const { subscription } = ctx.request.body.data.object;

  const subscriptionObj = await stripe.subscriptions.retrieve(subscription);

  debug(subscriptionObj);

  if (subscriptionObj.metadata.trial === 'auto') {
    // cancel_at is not on the type?
    const updateOptions: ISubscriptionUpdateOptions = {
      cancel_at: subscriptionObj.trial_end
    } as any;

    await stripe.subscriptions.update(subscription, updateOptions);
  } else {
    const listOptions: ISubscriptionListOptions = {
      customer: STRIPE_CUSTOMER_ID,
      status: 'trialing'
    };

    // find any trialing subscriptions that ARE trialing and are created before this new sub
    if (subscriptionObj.trial_start) {
      listOptions.created = {
        lt: `${subscriptionObj.trial_start}`
      }
    }

    debug(listOptions);

    const subscriptions = await stripe.subscriptions.list(listOptions);

    debug(subscriptions);

    // cancel them all
    await Promise.all(subscriptions.data.map((sub) => {
      debug(`Cancelling sub ${sub.id}`);
      return stripe.subscriptions.del(sub.id);
    }));
  }

  ctx.status = 200;
  ctx.body = {};
});

// middleware setup

// basic logging for each request
app.use(async (ctx, next) => {
  const { url, method } = ctx.request;
  const time = Date.now();

  await next();

  const newTime = Date.now();
  console.log(`${method.toUpperCase()} ${url} - ${ctx.status} ${newTime - time}ms`);
});

app.use(cors());

app.use(bodyparser({
  enableTypes: ['json']
}));

app.use(router.routes());
app.use(router.allowedMethods());

app.listen(8080, () => {
  console.log(`Stripe Checkout POC API is running at 8080`);
});