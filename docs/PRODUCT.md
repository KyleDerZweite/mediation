# Mediation: Live Coordination for Coding Agents

## Purpose

Build an independent coordination service that prevents developers and coding agents from unknowingly performing the same work.

The service exposes the live state that exists before work reaches Git:

* what each developer or agent is currently investigating;
* which bug, task, or feature they intend to change;
* which files and components they are touching;
* what they have already discovered;
* whether their work overlaps with another active session;
* whether their work has reached a commit, pull request, or merge.

## Problem

Git reliably shows committed work. It does not show local work that is still being investigated, edited, tested, or prepared for commit.

In a team using multiple coding agents, this creates an expensive visibility gap:

1. One agent discovers and starts fixing a bug.
2. Its changes remain local while the session continues.
3. Another developer or agent encounters the same bug.
4. Nothing visible indicates that the fix is already underway.
5. Both agents spend time and model usage solving the same problem.

Branches and pull requests help only after someone has created and published them. The product must make work visible from the moment it begins.

## Product Promise

> Before another developer or agent starts overlapping work, they can see that it is already being handled.

The product is the shared live coordination layer between planned work and committed work.

* Existing roadmaps describe what should happen.
* The coordination service describes what is happening now.
* Git describes what has been committed.
* Pull requests and CI describe what is ready to integrate.

## Core Product

Each active developer or agent session publishes a lightweight work claim containing:

* the intended change or investigation;
* the developer and agent performing it;
* the repository, branch, and starting revision;
* affected files or components;
* current status and important findings;
* recent activity;
* related commits or pull requests.

Claims expire when sessions disappear or stop reporting activity.

Before beginning work, an agent reads the current project state and checks for overlapping claims. Conflicts are warnings rather than hard locks. The agent can stop, coordinate with the existing owner, narrow its scope, or explicitly continue.

A minimal dashboard shows:

* active sessions;
* current work claims;
* recently changed files;
* discovered bugs and observations;
* possible conflicts;
* recent commits, pull requests, and completed work.

The product does not replace an issue tracker, roadmap, wiki, Git provider, CI system, or agent runtime.

## Development MVP

The first version exists only to prove that live visibility prevents duplicated work.

It may use an open endpoint with a shared project identifier and no authentication.

The MVP must support:

1. connecting multiple agent sessions to one project;
2. publishing and updating work claims;
3. reporting local repository state;
4. showing active work in a dashboard;
5. warning about overlapping files, components, or tasks;
6. attaching commits to completed work;
7. expiring abandoned sessions and claims;
8. allowing agents to discover and report newly found bugs.

The MVP is successful when a developer or agent sees existing work and decides not to duplicate it.

It does not need account management, billing, organizations, complex permissions, semantic AI conflict detection, or a full project-management interface.

## Production Identity Model

Production introduces human accounts, project membership, and scoped agent credentials.

A human identity owns the account. Agents do not become independent human users.

### Human onboarding

1. A user creates or claims an account through the dashboard.
2. The account may remain pending until approved by an instance administrator.
3. An approved user may create projects or join existing ones.
4. Project membership determines what the user and their agents may access.

Administrator approval should be an instance policy rather than mandatory product behavior. Private installations may require approval; public deployments may allow immediate access.

### Agent onboarding

The service publishes agent-readable authentication instructions similar to `auth.md`.

When an unauthenticated agent connects:

1. it discovers the registration flow;
2. it requests a new agent credential;
3. it receives a verification URL and short code;
4. the human signs in or creates an account;
5. the human confirms that the agent may act on their behalf;
6. approval is withheld while the human account is pending;
7. after approval, the agent receives a revocable credential scoped to that user.

Registering a new machine or agent should not require administrator approval each time. The user approves their own agents after their account has been admitted.

### Joining projects

Projects can be joined using an invite link or short join code.

A project invitation should be:

* expiring;
* revocable;
* optionally limited to a number of uses;
* assigned a default project role;
* useless without an authenticated and approved account.

Joining a project adds the human user. Their authorized agents inherit only that user's project access.

Agents should not independently redeem project invitations or create memberships without the human account's authorization.

### Permissions

The initial production model needs only:

* instance administrator;
* project administrator;
* project member.

Agent credentials receive narrower operational permissions such as reading project state, creating claims, reporting repository state, and updating their own sessions. Destructive project administration remains human-only.

## Production Goal

A production-ready release should provide:

* secure human accounts;
* optional administrator approval;
* project creation and membership;
* expiring project invitations;
* agent-readable registration;
* human-claimed and revocable agent credentials;
* project-scoped permissions;
* an audit trail identifying the human, agent, machine, and session behind each action.

These controls are a production boundary, not an MVP dependency.

## Product Boundary

The product succeeds by answering one question accurately:

> What are our developers and coding agents working on right now, before Git makes it visible?

Everything that does not materially improve that answer remains outside the product.
