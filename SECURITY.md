# Security policy

## Reporting a vulnerability

Please report security issues privately to **hello@edgekits.dev**, not through a public issue.
Include what you found, the steps to reproduce it, and what an attacker gets out of it. A proof
of concept helps but is not required.

RepoAccess is maintained by one person, so there is no bounty programme and no guaranteed
response window. Reports are read and answered, and a fix ships as a new release with the
problem described in the notes. If you would like credit in that note, say so and name how you
want to be credited.

Please give the fix a reasonable window before disclosing publicly.

## What is in scope

The code in this repository: the worker, the Stripe adapter, the grant and revoke engine, the
claim flow, the outbound event signing and the setup wizard. Anything that lets an attacker
obtain access they did not pay for, keep access after a refund, read another buyer's data, or
reach a secret is in scope.

## What is not in scope

A deployer's own Cloudflare, GitHub or payment-provider account, and the configuration they
write themselves. Vulnerabilities in Cloudflare, GitHub or a payment provider belong to those
vendors. A misconfigured deployment is a support question rather than a vulnerability, and the
setup guide is the place for it.

## Supported versions

The latest published version is the one that receives fixes.
