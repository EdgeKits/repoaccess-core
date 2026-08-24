# Licensing

RepoAccess core is **dual-licensed**. You may use it under either of the following, at your choice:

1. the **GNU Affero General Public License, version 3 or later (AGPL-3.0-or-later)**, whose full text is in
   [LICENSE](LICENSE); or
2. a **commercial license** granted by the copyright holder, which is how the code is delivered as part of
   **RepoAccess Pro**.

You do not need permission to choose the AGPL. It is the default, and it is a real open-source license: you
may run, study, modify, and redistribute the software under its terms.

## What the AGPL asks of you

The AGPL is a copyleft license. Two of its consequences matter in practice:

- **If you modify RepoAccess and let others interact with your modified version over a network, you must
  offer those users the complete corresponding source of your version**, at no charge, prominently (AGPL
  section 13, the "network clause"). Publishing your fork and linking to it from the running service is the
  normal way to satisfy this.
- **Combining RepoAccess with your own code generally makes the combined work subject to the AGPL.** If you
  offer that combined work over a network, you would owe its source to your users on the same terms.

Running RepoAccess **unmodified** to sell access to your own repositories is the intended use and asks nothing
extra of you: its source is already public, here.

The AGPL covers the RepoAccess source itself. It does not require you to open your repositories, your
customers' data, or your business.

## The commercial license

If either of the above is a problem for you, for example because you need to embed RepoAccess in a
closed-source product, or you do not want the network clause to apply to your deployment, then the same code
is available under a commercial license.

That license is delivered as **RepoAccess Pro**, which also adds the additional payment adapters, the
embeddable service, and support. Under it, the RepoAccess core code is licensed to you on the Pro terms and
**not** under the AGPL, so no AGPL obligation, including the network clause, attaches to your use of it.

For commercial licensing, see the [RepoAccess page](https://edgekits.dev/en/tools/repoaccess/).

## Why dual licensing is possible here

Offering the same code under two licenses requires that a single party hold the copyright to all of it. That
is the case: RepoAccess is written and owned by one author, and **the project deliberately does not accept
outside code contributions** so that it stays that way. See [CONTRIBUTING.md](CONTRIBUTING.md) for what that
means for you, and for what is welcome instead.

## Third-party code

RepoAccess core depends on [Hono](https://hono.dev/) (MIT licensed) as a peer dependency. Its license and
copyright notice are preserved in the package you install; nothing in this project alters them.

---

This page explains the licensing arrangement in plain terms. It is a summary, not a substitute for the license
texts themselves: the operative terms are those of [LICENSE](LICENSE) (AGPL-3.0-or-later) and, for Pro
licensees, of the Pro license agreement. If your situation is unusual, take advice on it.
