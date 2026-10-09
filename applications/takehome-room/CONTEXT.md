# takehome-room

A coding interview in a full remote desktop. The candidate uses the AI tools they choose. The reviewer gets the recording, the final state and the hidden test results in one place.

## People

**Candidate**:
The person being interviewed. They control the Room during the Interview.
_Avoid_: Applicant, user, interviewee

**Reviewer**:
The person at the hiring company who creates the Interview and judges the result. They never control the Room and never receive its stream link.
_Avoid_: Interviewer, admin, recruiter

## The interview

**Interview**:
One Candidate doing one Task, from invitation to Report.
_Avoid_: Session, assessment, test

**Demo**:
A short Interview that a visitor starts from the home page and plays both sides of: Candidate first, then reader of their own Report. Demos are capped per day.
_Avoid_: Trial, sample, preview

**Task**:
The work the Candidate is asked to do, given as a starting repository and written instructions.
_Avoid_: Challenge, problem, assignment

**Room**:
The remote desktop that belongs to one Interview. The Candidate reaches it through a link in their browser.
_Avoid_: VM, sandbox, machine, environment

**Slot**:
One of the machines the Solari plan allows at once (one on the free plan). An Interview holds a Slot from opening its Room until grading ends.
_Avoid_: Seat, capacity, concurrency

**Toolkit**:
The tools already installed in every Room before the Candidate arrives, such as editors, AI coding tools and language runtimes.
_Avoid_: Template, image, setup

## Time

**Setup time**:
A fixed period after the Candidate opens the Room, for signing in and adjusting tools. It does not count toward the Interview clock.
_Avoid_: Warm-up, grace period

**Interview clock**:
The time limit for the Task. When the Candidate presses Start, it starts. Opening the Room does not start it.
_Avoid_: Timer, deadline, session time

## Evidence

**Recording**:
The video of the Room's screen for the whole Interview. Screen only: no webcam and no audio.
_Avoid_: Replay, capture, proctoring

**Final state**:
The Room exactly as the Candidate left it, at Submit or at the end of the Interview clock.
_Avoid_: Snapshot, submission

**Hidden tests**:
Checks that the Reviewer wrote for the Task and that the Candidate never sees. They run against a copy of the Final state, never inside the Candidate's Room.
_Avoid_: Grader, evaluation, test suite

**Report**:
The single page the Reviewer reads after the Interview: the Recording, the Hidden test results and a way to open the Final state.
_Avoid_: Scorecard, results, dashboard
