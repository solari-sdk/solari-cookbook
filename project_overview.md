# 🚀 AI Job Search Agent

<p align="center">
  <strong>Your AI-powered job-search employee.</strong><br/>
  Find opportunities. Tailor applications. Reach the right people. Follow up until you get an answer.
</p>

---

## 📌 Overview

**AI Job Search Agent** is a full-stack recruitment automation platform built with **Next.js and TypeScript**.

It helps candidates manage the complete job-search lifecycle:

```text
Candidate Profile
       ↓
Job Discovery
       ↓
AI Job Matching
       ↓
Resume Tailoring
       ↓
Application Preparation
       ↓
Human Approval
       ↓
Application Submission
       ↓
Contact Discovery
       ↓
Personalized Outreach
       ↓
Follow-up Engine
       ↓
Email / Response Intelligence
       ↓
Outcome Tracking
       ↓
Career Analytics
```

The goal is **not** to build a blind auto-apply bot.

The goal is to build an **AI job-search employee** that handles repetitive work while keeping the candidate in control of important decisions.

---

# ✨ Why This Exists

Traditional job searching often looks like:

```text
Find Job
   ↓
Read JD
   ↓
Modify Resume
   ↓
Fill Form
   ↓
Apply
   ↓
Forget About It
```

This platform turns it into:

```text
Find
 ↓
Understand
 ↓
Match
 ↓
Tailor
 ↓
Apply
 ↓
Find the right person
 ↓
Reach out
 ↓
Follow up
 ↓
Understand replies
 ↓
Track outcome
 ↓
Learn
 ↓
Improve
 ↓
Repeat
```

The biggest differentiator is the **Follow-up Engine**.

Most application tools stop at:

> "Application submitted."

This platform continues managing the opportunity until a response or outcome is received.

---

# 🎯 Core Features

## 👤 Candidate Profile

Create a centralized career profile containing:

- Personal information
- Education
- Work experience
- Technical skills
- Projects
- Certifications
- Preferred roles
- Preferred locations
- Salary expectations
- Remote / Hybrid / On-site preference
- Notice period
- Job-search preferences

---

## 📄 Master Resume

Upload a primary resume and convert it into structured candidate data.

The system extracts:

- Experience
- Skills
- Technologies
- Projects
- Education
- Achievements
- Certifications

The master resume is the **source of truth**.

AI-generated resumes must never fabricate:

- Experience
- Skills
- Companies
- Projects
- Qualifications
- Achievements
- Credentials

---

## 🔎 AI Job Discovery

Discover opportunities from supported job sources and company career pages.

Potential sources:

- LinkedIn
- Wellfound
- Indeed
- YC Jobs
- Company career pages
- Other supported sources

Every job is normalized into a common structure.

```json
{
  "title": "Software Engineer Intern",
  "company": "Example Corp",
  "location": "Remote",
  "employmentType": "Internship",
  "description": "...",
  "skills": ["React", "TypeScript", "Next.js"],
  "source": "Wellfound",
  "url": "..."
}
```

---

## 🧠 AI Job Matching

Every job receives an explainable match score.

```text
Software Engineer Intern

Match Score: 94%

Skills          96%
Experience      92%
Projects        95%
Education      100%
Location       100%
```

The system explains:

- Why the candidate matches
- Which requirements are satisfied
- Which requirements are missing
- Potential concerns

---

## 📑 AI Resume Tailoring

Generate a job-specific resume from the master resume.

```text
Master Resume
      +
Job Description
      ↓
Resume Agent
      ↓
Tailored Resume
```

The agent can:

- Reorder relevant experience
- Highlight relevant projects
- Improve bullet points
- Adjust the professional summary
- Emphasize relevant technologies
- Reduce irrelevant emphasis

Every tailored resume remains linked to the master resume.

---

## 🤖 Application Agent

Use browser automation to assist with supported job applications.

```text
Job
 ↓
Open Application
 ↓
Understand Form
 ↓
Map Candidate Data
 ↓
Generate Answers
 ↓
Fill Fields
 ↓
Upload Resume
 ↓
Review
 ↓
User Approval
 ↓
Submit
```

Ambiguous or sensitive questions should be escalated to the user instead of guessed.

### Human-in-the-loop

Important actions require user approval:

- Final application submission
- Sensitive application answers
- Outbound emails
- Potentially sensitive responses

---

# 🎯 Contact Discovery

After identifying a strong opportunity, research publicly available professional information.

Priority:

```text
Hiring Manager
      ↓
Recruiter
      ↓
Founder / Relevant Executive
      ↓
General Company Contact
```

Only legitimate publicly available professional information should be used.

If no suitable email is available, the platform can provide the relevant professional profile for manual outreach.

---

# ✉️ AI Cold Outreach

Generate personalized outreach using:

```text
Job Description
      +
Candidate Profile
      +
Company Information
      +
Contact Information
      ↓
Personalized Email
```

The system should avoid generic mass-email language and personalize messages around the actual opportunity.

Workflow:

```text
AI Generates Email
        ↓
User Reviews
        ↓
User Edits (Optional)
        ↓
User Approves
        ↓
Email Sent
```

---

# 🔥 Follow-up Engine

## The Core Differentiator

The platform does not treat an application as a completed task.

It treats it as an **ongoing opportunity**.

```text
Application Submitted
        ↓
Outreach Sent
        ↓
Waiting
        ↓
Follow-up Decision
        ↓
       Reply?
      /      \
    YES       NO
     ↓         ↓
Analyze     Prepare Follow-up
Response        ↓
     ↓       User Approval
Next Action     ↓
             Send
                ↓
              Wait
```

Example:

```text
DAY 0
✓ Application submitted
✓ Recruiter contacted

DAY 3
No response
→ Follow-up #1 prepared

DAY 7
Still no response
→ Follow-up #2 prepared

DAY 14
Still no response
→ Final follow-up / close opportunity
```

Follow-up decisions can consider:

- Previous emails
- Previous responses
- Time elapsed
- Job status
- Contact type
- Conversation context
- Existing conversations

---

# 🧠 Intelligent Response Handling

Example:

Recruiter:

> Can you send your GitHub?

The agent identifies:

```text
Intent:
Interested

Required Action:
Send GitHub

Suggested Response:
Ready
```

Another example:

> We're not hiring interns right now, but maybe next quarter.

The system can classify:

```text
Intent:
Future Opportunity

Action:
Schedule future follow-up
```

---

# 📬 Email Intelligence

Connect a supported email account to identify recruitment conversations.

Possible classifications:

```text
🟢 Interested
🔵 Interview
🟣 Needs Response
🟡 Waiting
🔴 Rejected
⚪ No Response
```

Workflow:

```text
Incoming Email
      ↓
Email Intelligence Agent
      ↓
Classify Intent
      ↓
Identify Required Action
      ↓
Generate Suggested Response
      ↓
User Approval
```

---

# 🗂️ Application Timeline

Every opportunity gets a complete activity timeline.

```text
ACME — Software Engineer Intern

Sept 1
✓ Job discovered

Sept 1
✓ Match score: 94%

Sept 1
✓ Resume tailored

Sept 1
✓ Application submitted

Sept 1
✓ Recruiter contacted

Sept 4
✓ Follow-up #1 sent

Sept 6
✓ Recruiter replied

Sept 6
⚡ Interview requested
```

---

# 📊 Dashboard

The dashboard is the command center.

Example:

```text
Good morning 👋

Jobs Found             182
Strong Matches          47
Applications            23
Outreach Sent           19
Replies                  6
Interviews               4

Response Rate         31.5%
```

Application table:

| Company | Role | Match | Application | Outreach | Status |
|---|---|---:|---|---|---|
| Acme | SWE Intern | 94% | Submitted | Sent | Waiting |
| XYZ | Backend Intern | 91% | Submitted | Replied | Interview |
| ABC | Fullstack | 87% | Submitted | Sent | Follow-up |

---

# 📈 Career Intelligence

The system learns from application outcomes.

### Role Performance

```text
Fullstack Developer       93%
Backend Developer         89%
AI Engineer               84%
Frontend Developer        79%
```

### Skill Gaps

```text
AWS
Docker
Redis
Kubernetes
System Design
```

### Resume Performance

```text
Resume A
Applications: 15
Responses: 5
Response Rate: 33%

Resume B
Applications: 21
Responses: 2
Response Rate: 9%
```

The AI can provide insights such as:

> Your backend-focused resume is generating significantly more responses than your general resume.

---

# 🏗️ Architecture

```text
                         ┌───────────────────┐
                         │     Next.js       │
                         │                   │
                         │ Dashboard         │
                         │ Jobs              │
                         │ Applications      │
                         │ Outreach          │
                         │ Follow-ups        │
                         │ Analytics         │
                         └─────────┬─────────┘
                                   │
                                   ▼
                         ┌───────────────────┐
                         │ Backend / API     │
                         └─────────┬─────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
              ▼                    ▼                    ▼
        PostgreSQL              Queue             Object Storage
              │                    │
              │                    ▼
              │              Agent Workers
              │                    │
              │             ┌──────┴──────┐
              │             ▼             ▼
              │            LLM          Solari
              │                           │
              │                  ┌────────┼────────┐
              │                  ▼        ▼        ▼
              │               Browser  Sandbox  Desktop
              │
              └───────────────────┐
                                  ▼
                           Application Data
                                  │
                                  ▼
                              Analytics
```

---

# 🧩 Agent Architecture

```text
                    ORCHESTRATOR
                         │
       ┌─────────────────┼──────────────────┐
       │                 │                  │
       ▼                 ▼                  ▼
 Job Discovery       Resume Agent      Contact Agent
       │                 │                  │
       ▼                 ▼                  ▼
 Job Matcher       Resume Tailor      Contact Research
       │
       ▼
 Application Agent
       │
       ▼
 Outreach Agent
       │
       ▼
 Follow-up Agent
       │
       ▼
 Email Intelligence
```

### Agents

| Agent | Responsibility |
|---|---|
| Job Discovery | Find and normalize jobs |
| Job Matcher | Score candidate/job compatibility |
| Resume Agent | Generate truthful tailored resumes |
| Application Agent | Assist with browser-based applications |
| Contact Agent | Research relevant professional contacts |
| Outreach Agent | Generate personalized outreach |
| Follow-up Agent | Manage follow-up lifecycle |
| Email Intelligence | Classify replies and suggest actions |

---

# 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js |
| Language | TypeScript |
| UI | React |
| Database | PostgreSQL |
| ORM | Prisma |
| Browser Automation | Solari |
| AI | LLM Provider |
| Authentication | Auth.js / suitable auth provider |
| File Storage | S3-compatible storage |
| Background Jobs | Queue + Workers |
| Email | Gmail / Outlook integration |
| Deployment | Vercel + Worker Infrastructure |

---

# 📁 Project Structure

```text
ai-job-agent/
│
├── app/
│   ├── (auth)/
│   │   ├── login/
│   │   └── signup/
│   │
│   ├── dashboard/
│   │   ├── page.tsx
│   │   ├── jobs/
│   │   ├── applications/
│   │   ├── outreach/
│   │   ├── follow-ups/
│   │   ├── conversations/
│   │   ├── resume/
│   │   ├── analytics/
│   │   └── settings/
│   │
│   ├── api/
│   │   ├── jobs/
│   │   ├── applications/
│   │   ├── resume/
│   │   ├── outreach/
│   │   ├── follow-ups/
│   │   └── webhooks/
│   │
│   ├── layout.tsx
│   └── page.tsx
│
├── agents/
│   ├── job-discovery/
│   ├── job-matching/
│   ├── resume/
│   ├── application/
│   ├── contact-discovery/
│   ├── outreach/
│   ├── follow-up/
│   └── email-intelligence/
│
├── components/
│   ├── dashboard/
│   ├── jobs/
│   ├── applications/
│   ├── outreach/
│   ├── follow-ups/
│   └── ui/
│
├── lib/
│   ├── ai/
│   ├── solari/
│   ├── database/
│   ├── email/
│   ├── storage/
│   └── queue/
│
├── prisma/
│   └── schema.prisma
│
├── workers/
│   ├── job-worker.ts
│   ├── application-worker.ts
│   ├── outreach-worker.ts
│   └── followup-worker.ts
│
├── types/
├── knowledge/
├── public/
│
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

# ⚙️ Getting Started

## Prerequisites

Make sure you have:

- Node.js 20+
- npm / pnpm / yarn
- PostgreSQL database
- Git
- Required AI provider API key
- Solari account/API credentials
- Gmail/Outlook integration credentials if email features are enabled

---

## 1. Clone the Repository

```bash
git clone https://github.com/YOUR_USERNAME/ai-job-agent.git

cd ai-job-agent
```

---

## 2. Install Dependencies

```bash
npm install
```

---

## 3. Configure Environment Variables

Create a `.env.local` file:

```bash
cp .env.example .env.local
```

Example:

```env
# Application
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Database
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE"

# Authentication
AUTH_SECRET="replace-with-a-secure-secret"

# AI
AI_API_KEY="your-api-key"

# Solari
SOLARI_API_KEY="your-solari-api-key"

# Storage
STORAGE_ENDPOINT=""
STORAGE_ACCESS_KEY=""
STORAGE_SECRET_KEY=""
STORAGE_BUCKET=""

# Email
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""

MICROSOFT_CLIENT_ID=""
MICROSOFT_CLIENT_SECRET=""

# Background Jobs
QUEUE_URL=""
```

> **Never commit `.env.local` or production secrets to Git.**

---

# 🗄️ Database Setup

After configuring `DATABASE_URL`:

```bash
npx prisma generate
```

Run migrations:

```bash
npx prisma migrate dev
```

Open Prisma Studio:

```bash
npx prisma studio
```

For production:

```bash
npx prisma migrate deploy
```

---

# ▶️ Run the Development Server

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

---

# 📜 Available Scripts

Expected scripts:

```bash
npm run dev
npm run build
npm run start
npm run lint
```

Database:

```bash
npm run db:generate
npm run db:migrate
npm run db:studio
```

If using dedicated workers:

```bash
npm run worker
```

---

# 🔄 Background Job Architecture

Long-running agent operations should be processed asynchronously.

Example:

```text
User
 ↓
Next.js API
 ↓
Create Job
 ↓
Queue
 ↓
Worker
 ↓
Agent
 ↓
Solari / LLM
 ↓
Database
 ↓
Dashboard
```

Example workers:

```text
Job Discovery Worker
Application Worker
Resume Worker
Outreach Worker
Follow-up Worker
Email Processing Worker
Analytics Worker
```

This prevents long-running browser and AI workflows from blocking normal HTTP requests.

---

# 🗃️ Core Data Model

Conceptually:

```text
User
 │
 ├── CandidateProfile
 │
 ├── Resume
 │    ├── Master
 │    └── Tailored Versions
 │
 ├── Job
 │
 ├── Application
 │     ├── Job
 │     ├── ResumeVersion
 │     ├── Answers
 │     ├── Status
 │     └── ActivityLog
 │
 ├── Contact
 │
 ├── Outreach
 │     ├── Contact
 │     ├── Email
 │     └── Status
 │
 ├── FollowUp
 │
 ├── Conversation
 │
 └── PlatformConnection
```

---

# 🔄 Application State Machine

```text
DISCOVERED
    ↓
MATCHED
    ↓
REVIEW_PENDING
    ↓
RESUME_READY
    ↓
APPLICATION_READY
    ↓
APPROVED
    ↓
SUBMITTED
    ↓
OUTREACH_SENT
    ↓
WAITING
    ├───────────────┐
    ↓               ↓
FOLLOW_UP       RESPONSE
    ↓               ↓
FOLLOW_UP_SENT  RESPONSE_ANALYZED
                    │
              ┌─────┴─────┐
              ↓           ↓
          INTERVIEW    REJECTED
```

---

# 🔐 Security & Trust

This application handles sensitive career information and communicates externally.

## No Fabricated Information

The AI must never invent candidate information.

## Human Approval

Require explicit approval for important actions:

- Final application submission
- Outbound cold emails
- Sensitive application answers
- Potentially sensitive email responses

## Public Professional Information

Contact discovery should use legitimate publicly available professional information.

## Platform Compliance

Automation should respect the terms, technical restrictions, and applicable policies of each platform.

## Credential Security

Use OAuth or approved authentication mechanisms whenever available instead of storing raw platform passwords.

## Audit Logs

Important actions should be logged:

```text
User
Action
Timestamp
Job
Contact
Message
Agent
Result
```

---

# 🧪 Testing Strategy

Testing should cover both deterministic application logic and agent workflows.

## Unit Tests

Test:

- Job scoring
- Resume parsing
- Data normalization
- Follow-up scheduling
- Application state transitions
- Email classification
- Permission checks

## Integration Tests

Test:

- Database operations
- Email provider integration
- AI provider integration
- Solari integration
- Queue workers
- Webhooks

## End-to-End Tests

Important flows:

```text
Signup
 ↓
Upload Resume
 ↓
Create Profile
 ↓
Discover Job
 ↓
Generate Match
 ↓
Tailor Resume
 ↓
Prepare Application
 ↓
Approve
 ↓
Submit
 ↓
Generate Outreach
 ↓
Approve
 ↓
Send
 ↓
Receive Reply
 ↓
Classify
 ↓
Suggest Action
```

---

# 🧪 MVP Roadmap

## Phase 1 — Foundation

- [ ] Next.js application
- [ ] Authentication
- [ ] PostgreSQL
- [ ] Prisma
- [ ] Candidate profile
- [ ] Resume upload
- [ ] Resume parsing
- [ ] Dashboard

## Phase 2 — Job Discovery

- [ ] Job source integration
- [ ] Job normalization
- [ ] Job database
- [ ] Job matching
- [ ] Match score
- [ ] Explainable matching

## Phase 3 — Resume Agent

- [ ] Master resume
- [ ] Resume parsing
- [ ] JD analysis
- [ ] Tailored resume generation
- [ ] Resume preview
- [ ] Version history

## Phase 4 — Application Agent

- [ ] Browser automation
- [ ] Form detection
- [ ] Candidate-field mapping
- [ ] AI question answering
- [ ] Application preview
- [ ] Human approval
- [ ] Submission
- [ ] Activity logging

## Phase 5 — Outreach

- [ ] Company research
- [ ] Contact discovery
- [ ] Contact prioritization
- [ ] Personalized email generation
- [ ] Email preview
- [ ] Gmail/Outlook integration
- [ ] User approval
- [ ] Email sending

## Phase 6 — Follow-up Engine ⭐

- [ ] Follow-up scheduler
- [ ] Conversation context
- [ ] No-response detection
- [ ] AI follow-up generation
- [ ] Follow-up approval
- [ ] Follow-up sending
- [ ] Automatic cancellation after response
- [ ] Response classification
- [ ] Suggested replies
- [ ] Future follow-up scheduling

## Phase 7 — Career Intelligence

- [ ] Application analytics
- [ ] Response rate
- [ ] Interview rate
- [ ] Resume performance
- [ ] Skill-gap analysis
- [ ] Role performance
- [ ] AI career recommendations

---

# 🎯 MVP Success Criteria

The MVP is considered successful when a user can:

- [ ] Create a career profile
- [ ] Upload a master resume
- [ ] Discover relevant jobs
- [ ] Receive an explainable match score
- [ ] Generate a truthful tailored resume
- [ ] Prepare an application
- [ ] Review and approve an application
- [ ] Submit an application
- [ ] Find a relevant professional contact
- [ ] Generate personalized outreach
- [ ] Review and send the email
- [ ] Track the opportunity
- [ ] Automatically prepare intelligent follow-ups
- [ ] Detect and classify replies
- [ ] Suggest the next action
- [ ] View the complete opportunity timeline

---

# 🧭 Product Vision

The long-term goal is:

## **An AI Employee for Your Job Search**

Not:

```text
Find → Apply
```

But:

```text
Find
 ↓
Understand
 ↓
Match
 ↓
Tailor
 ↓
Apply
 ↓
Find the Right Person
 ↓
Reach Out
 ↓
Follow Up
 ↓
Understand Replies
 ↓
Respond
 ↓
Track Outcome
 ↓
Learn
 ↓
Improve
 ↓
Repeat
```

---

# 💡 Core Product Philosophy

> **A job application should not be treated as a button click. It should be treated as an ongoing opportunity.**

The system should continuously ask:

- Is this job a good fit?
- How should the candidate present themselves?
- Who is the right person to contact?
- Did they respond?
- Should we follow up?
- What did they say?
- Does the candidate need to respond?
- Is the role still active?
- Should this opportunity remain open?
- What can we learn from the outcome?

That continuous loop is what transforms this from an **AI auto-apply tool** into a genuine **AI job-search agent**.

---

# 🏆 Final Value Proposition

### For candidates

> **Spend less time applying and more time getting interviews.**

### For the product

```text
                    AI JOB SEARCH AGENT
                            │
             ┌──────────────┴──────────────┐
             │                             │
       OPPORTUNITY                    RELATIONSHIP
             │                             │
        Find Jobs                     Find People
             │                             │
        Match Jobs                    Outreach
             │                             │
      Tailor Resume                  Follow Up
             │                             │
          Apply                      Understand
             │                             │
             └──────────────┬──────────────┘
                            ↓
                         OUTCOME
                            ↓
                     LEARN & IMPROVE
                            ↓
                          REPEAT
```

### The objective:

> **Build an AI agent that manages the entire job-search lifecycle — from discovering an opportunity to getting a response.**

---

# 📄 License

Add the project's chosen license here before making the repository public.
