# PatchPilot

**Autonomous Software Engineer for Reproducing, Fixing, Testing, and Verifying Real Bugs**

PatchPilot is an autonomous software-engineering agent built with **Solari Browser** + **Solari Sandbox**.

PatchPilot runs against a web application and its source code. It reproduces a real user-facing bug, investigates the source code inside an isolated sandbox, generates and applies a patch, runs the application's tests, and finally opens a fresh browser session to independently verify that the fix actually works.

> Browser discovers the failure. Sandbox fixes the code. Tests validate the patch. A fresh browser verifies the result.

---

## Table of Contents

- [The Problem](#the-problem)
- [Demo](#demo)
- [End-to-End Workflow](#end-to-end-workflow)
- [Why Solari?](#why-solari)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Technology Stack](#technology-stack)
- [Frontend Dashboard](#frontend-dashboard)
- [Getting Started](#getting-started)
- [What Happens When You Run It?](#what-happens-when-you-run-it)
- [Evidence](#evidence)
- [Design Principles](#design-principles)
- [What Makes PatchPilot Different?](#what-makes-patchpilot-different)
- [Current MVP](#current-mvp)
- [Future Direction](#future-direction)
- [Security Considerations](#security-considerations)
- [Challenge Context](#challenge-context)
- [The Core Idea](#the-core-idea)
- [Author](#author)
- [License](#license)

---

## The Problem

A typical software debugging workflow looks like:

```
User reports bug
      ↓
Developer reproduces it
      ↓
Developer searches the codebase
      ↓
Developer identifies root cause
      ↓
Developer edits the code
      ↓
Developer runs tests
      ↓
Developer manually verifies the fix
```

PatchPilot turns this into an autonomous engineering loop:

```
        ┌──────────────────────┐
        │    Running Web App   │
        └──────────┬───────────┘
                    ↓
        ┌──────────────────────┐
        │    Solari Browser    │
        │   Reproduce Bug      │
        └──────────┬───────────┘
                    ↓
        ┌──────────────────────┐
        │    Solari Sandbox    │
        │                      │
        │  Inspect Source      │
        │  Find Root Cause     │
        │  Apply Patch         │
        └──────────┬───────────┘
                    ↓
        ┌──────────────────────┐
        │     Test Suite       │
        │    Validate Patch    │
        └──────────┬───────────┘
                    ↓
        ┌──────────────────────┐
        │ Fresh Solari Browser │
        │   Verify Fix         │
        └──────────┬───────────┘
                    ↓
             FIX VERIFIED
```

---

## Demo

PatchPilot operates on a deliberately broken shopping-cart application.

The application contains the following bug:

```typescript
export function calculateTotal(
  price: number,
  quantity: number
): number {
  // BUG: quantity is accidentally ignored.
  return price;
}
```

A user selects:

| Field    | Value |
|----------|-------|
| Price    | $10   |
| Quantity | 3     |

The application incorrectly returns:

```
$10
```

PatchPilot discovers the failure through the browser.

It then investigates the application source inside the Solari Sandbox and identifies the root cause:

> The cart calculation ignores the quantity parameter.

PatchPilot generates and applies:

```diff
- return price;
+ return price * quantity;
```

The test suite then passes:

```
Tests: PASSED
```

Finally, PatchPilot starts the patched application and opens it in a fresh Solari Browser session.

The original workflow is executed again:

```
Quantity: 3
Expected: $30
Actual:   $30
```

**Result:**

```
🎉 FIX VERIFIED
```

---

## End-to-End Workflow

PatchPilot executes the following pipeline.

### 1. Bug Discovery

The application is opened using Solari Browser.

PatchPilot interacts with the UI like a real user:

- Opens the application
- Locates the relevant input
- Enters a quantity
- Clicks the calculation button
- Reads the result
- Compares the observed behavior with the expected behavior

Example:

```
Browser result: $10
Expected:       $30

🐛 BUG REPRODUCED
```

### 2. Root-Cause Analysis

Once the bug is reproduced, PatchPilot switches to the Solari Sandbox.

It searches the application source:

```
src/
```

and inspects relevant TypeScript files.

It identifies:

- **File:** `src/cart.ts`
- **Root cause:** The cart calculation ignores the quantity parameter.

The faulty implementation:

```typescript
return price;
```

### 3. Autonomous Patch

PatchPilot applies the required code change inside the isolated sandbox.

```diff
--- src/cart.ts
+++ src/cart.ts
- return price;
+ return price * quantity;
```

The source is modified without changing the host application's files.

### 4. Automated Testing

PatchPilot runs the application's test suite inside the sandbox.

```
🧪 Running tests...
✅ Tests passed
```

A successful source modification alone is not considered sufficient. The patch must pass the application's tests.

### 5. Patched Application

After the tests pass, PatchPilot starts the patched application separately.

This creates a new application instance containing the modified source.

### 6. Independent Browser Verification

PatchPilot launches another Solari Browser session.

It performs the same user workflow used to reproduce the original bug:

```
Quantity: 3
```

The patched application returns:

```
$30
```

PatchPilot verifies:

```
Expected: $30
Actual:   $30
```

Final state:

```
🎉 FIX VERIFIED
```

This final step ensures the patch works at the product/UI level, not only at the unit-test level.

---

## Why Solari?

PatchPilot is built around the combination of browser automation and isolated compute.

### Solari Browser

The browser acts as PatchPilot's view of the product.

It is responsible for:

- Navigating the application
- Interacting with UI elements
- Reproducing user behavior
- Observing application output
- Verifying the final fix

```
Solari Browser
      ↓
Observe Product
      ↓
Reproduce Failure
      ↓
Verify Fix
```

### Solari Sandbox

The sandbox acts as PatchPilot's engineering environment.

It is responsible for:

- Creating an isolated workspace
- Uploading source files
- Installing dependencies
- Inspecting source code
- Applying code changes
- Running tests
- Starting the patched application

```
Solari Sandbox
      ↓
Inspect Code
      ↓
Modify Code
      ↓
Run Tests
      ↓
Start Patched App
```

Together:

```
Browser
   ↓
Observed Failure
   ↓
Sandbox
   ↓
Code Change
   ↓
Tests
   ↓
Fresh Browser
   ↓
Verified Fix
```

---

## Architecture

```
                         PATCHPILOT
                             │
                             ▼
                  ┌─────────────────────┐
                  │    Web Application  │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │   Solari Browser    │
                  │                     │
                  │  Reproduce Bug      │
                  │  Observe Failure    │
                  └──────────┬──────────┘
                             │
                             │ Bug Report
                             ▼
                  ┌─────────────────────┐
                  │   Solari Sandbox    │
                  │                     │
                  │  Discover Source    │
                  │  Inspect Code       │
                  │  Analyze Root Cause │
                  └──────────┬──────────┘
                             │
                             │ Patch
                             ▼
                  ┌─────────────────────┐
                  │    Patch Engine     │
                  │                     │
                  │  Apply Code Change  │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │    Test Runner      │
                  │                     │
                  │      npm test       │
                  └──────────┬──────────┘
                             │
                             │ Tests Pass
                             ▼
                  ┌─────────────────────┐
                  │ Patched Application │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ Fresh Solari Browser│
                  │                     │
                  │ Independent Verify  │
                  └──────────┬──────────┘
                             │
                             ▼
                    ┌────────────────┐
                    │  FIX VERIFIED   │
                    └────────────────┘
```

---

## Project Structure

```
patchpilot/
│
├── src/
│   ├── index.ts
│   │
│   ├── agent/
│   │   ├── bug-analyzer.ts
│   │   ├── evidence.ts
│   │   ├── llm.ts
│   │   ├── patch-generator.ts
│   │   ├── planner.ts
│   │   ├── prompts.ts
│   │   └── verifier.ts
│   │
│   ├── solari/
│   │   ├── browser.ts
│   │   └── sandbox.ts
│   │
│   └── tools/
│       └── run-tests.ts
│
├── demo-app/
│   ├── src/
│   │   ├── cart.ts
│   │   ├── index.html
│   │   └── server.ts
│   │
│   ├── tests/
│   │   └── cart.test.ts
│   │
│   ├── package.json
│   └── package-lock.json
│
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── tsconfig.json
└── README.md
```

---

## Technology Stack

**Core**
- TypeScript
- Node.js
- npm

**Solari**
- Solari Browser
- Solari Sandbox

**Demo Application**
- Node.js HTTP server
- TypeScript
- HTML
- Browser JavaScript

**Testing**
- Node.js built-in test runner

**Development**
- TypeScript
- tsx
- dotenv

---

## Frontend Dashboard

PatchPilot includes a **React + TypeScript** dashboard built with **Vite** to visualize the autonomous debugging workflow in real time.

The dashboard displays:

- 🐛 Bug discovery and reproduction
- 🔍 Root cause analysis
- 🔧 Generated patch and code diff
- 🧪 Automated test results
- 🌐 Fresh-browser verification
- ✅ Final `FIX VERIFIED` status

The frontend connects to the PatchPilot Node.js API and continuously updates as the agent progresses through each stage.

**Stack:** React, TypeScript, Vite, CSS

---

## Getting Started

### Requirements

- Node.js 20+
- npm
- Solari API key

### Setup

Create a `.env` file in the project root:

```
SOLARI_API_KEY=your_solari_api_key
```

Install dependencies:

```bash
npm install
```

Run PatchPilot:

```bash
npm run dev
```

---

## What Happens When You Run It?

Running:

```bash
npm run dev
```

starts the complete autonomous workflow.

**Step 1** — PatchPilot creates an isolated Solari Sandbox.

```
📦 Creating Solari sandbox...
✅ Solari sandbox created
```

**Step 2** — The demo application is uploaded into the sandbox.

```
📤 Uploading demo app...
```

**Step 3** — Dependencies are installed.

```
📦 Installing dependencies...
✅ Dependencies installed
```

**Step 4** — The intentionally broken application starts.

```
🚀 Starting buggy application...
```

**Step 5** — Solari Browser reproduces the bug.

```
🐛 BUG REPRODUCED
Expected: $30
Actual:   $10
```

**Step 6** — PatchPilot analyzes the source.

```
🎯 ROOT CAUSE IDENTIFIED
File: src/cart.ts
```

**Step 7** — The patch is applied.

```diff
- return price;
+ return price * quantity;
```

**Step 8** — Tests run.

```
🧪 Running tests...
✅ Tests passed
```

**Step 9** — The patched application starts.

**Step 10** — A fresh Solari Browser verifies the fix.

```
🎉 FIX VERIFIED
Expected: $30
Actual:   $30
```

---

## Evidence

PatchPilot can produce structured evidence from the execution.

The evidence directory contains:

```
artifacts/
├── bug-report.json
├── analysis.json
├── patch.diff
└── verification.json
```

The artifacts represent the major stages of the autonomous workflow:

```
Bug Report
    ↓
Root Cause Analysis
    ↓
Code Patch
    ↓
Independent Verification
```

This makes the workflow easier to inspect and demonstrate.

---

## Design Principles

### Reproduce Before Fixing

PatchPilot first establishes that the reported behavior exists. It does not blindly modify source code.

```
Observe
  ↓
Reproduce
  ↓
Understand
  ↓
Fix
```

### Isolated Engineering Environment

Source inspection and modification happen inside a Solari Sandbox. This separates the autonomous coding environment from the host machine.

### Tests Are Required

A successful file modification does not mean the bug is fixed. PatchPilot runs the application's test suite after applying the patch.

```
Patch
 ↓
Tests
 ↓
Pass / Fail
```

### Product-Level Verification

Unit tests are not the final authority. PatchPilot starts the patched application and verifies the original workflow through a fresh browser session.

```
Tests Passed
     ↓
Fresh Browser
     ↓
User Workflow
     ↓
Expected Result
```

### Evidence Over Claims

Instead of simply saying "the AI fixed the bug," PatchPilot exposes the stages of the operation:

```
Bug reproduced
      ↓
Root cause identified
      ↓
Patch applied
      ↓
Tests passed
      ↓
Browser verification passed
```

---

## What Makes PatchPilot Different?

PatchPilot connects two traditionally separate perspectives of software engineering:

| Perspective | Question |
|-------------|----------|
| **The Product Perspective** | What does the user actually experience? |
| **The Code Perspective** | Why does the application behave this way? |

PatchPilot connects them:

```
             USER EXPERIENCE
                    │
                    ▼
             Solari Browser
                    │
                    ▼
             Observed Failure
                    │
                    ▼
             Solari Sandbox
                    │
                    ▼
              Source Analysis
                    │
                    ▼
                Code Patch
                    │
                    ▼
                 Testing
                    │
                    ▼
             Fresh Browser
                    │
                    ▼
             VERIFIED RESULT
```

The key idea is the feedback loop between real application behavior and source-code modification.

---

## Current MVP

The current implementation demonstrates the complete autonomous debugging loop using a controlled web application.

**Supported:**

- Browser-based bug reproduction
- Isolated sandbox execution
- Source-code discovery
- Root-cause analysis
- Automated patch application
- Automated testing
- Independent browser verification
- Evidence generation

The MVP intentionally keeps the system small and inspectable.

---

## Future Direction

PatchPilot can evolve into a broader autonomous software-engineering system.

Potential extensions include:

**Repository Integration**
Accept a GitHub repository and automatically prepare it for analysis.

**Natural-Language Bug Reports**
Allow developers to provide reports such as:

> "Cart totals are incorrect when the quantity is greater than one."

**Automatic Regression Tests**
Generate a regression test from the reproduced failure before applying the patch.

**Patch Retry**
If a generated patch fails tests:

```
Patch
 ↓
Tests Failed
 ↓
Analyze Failure
 ↓
Generate New Patch
 ↓
Tests
```

**Pull Request Generation**
Automatically create a pull request containing:

- Root-cause explanation
- Code diff
- Tests
- Browser verification evidence

**Staging Environment Support**
Run the same workflow against real staging applications.

**Multi-Language Support**
Extend source analysis and patching beyond TypeScript.

---

## Security Considerations

PatchPilot is designed around isolated execution.

The source-code modification workflow runs inside a Solari Sandbox rather than directly modifying the host environment.

API credentials should be stored locally in `.env` and should never be committed to Git.

`.env` is intentionally excluded from version control.

---

## Challenge Context

PatchPilot was created as a practical use case for Solari Browser and Solari Sandbox.

The project demonstrates how browser automation and isolated compute can be combined into a complete autonomous software-engineering workflow.

Instead of using Solari only for browser automation or code execution independently, PatchPilot combines both capabilities:

```
Browser Automation
        +
Isolated Compute
        ↓
Autonomous Debugging Workflow
```

---

## The Core Idea

The goal of PatchPilot is not simply to generate code.

The goal is to establish a complete loop:

```
┌──────────────┐
│ Find a Bug   │
└──────┬───────┘
       ↓
┌──────────────┐
│ Reproduce It │
└──────┬───────┘
       ↓
┌──────────────┐
│ Understand It│
└──────┬───────┘
       ↓
┌──────────────┐
│ Fix the Code │
└──────┬───────┘
       ↓
┌──────────────┐
│ Run Tests    │
└──────┬───────┘
       ↓
┌──────────────┐
│ Verify Again │
└──────┬───────┘
       ↓
┌────────────────┐
│ VERIFIED FIX   │
└────────────────┘
```

A patch is not successful until the application itself proves that the bug is gone.

---

## Author

**Muhammad Midhat**
AI/ML & Full-Stack Engineer
7+ years of experience building AI/ML and full-stack systems.

**Core Technologies:** Python · TypeScript · JavaScript · React · Next.js · Node.js · FastAPI · Django · LLM applications · RAG · Computer Vision · Distributed Systems

GitHub: [@midhat81](https://github.com/midhat81)

---

## License

This project is provided for demonstration and experimentation.