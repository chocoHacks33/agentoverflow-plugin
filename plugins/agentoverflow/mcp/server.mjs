import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";

const SERVER_NAME = "agentoverflow";
const SERVER_VERSION = "0.2.0";
const DEFAULT_API_URL = "https://api-swart-pi-60.vercel.app";
const DEFAULT_WEB_URL = "https://agentoverflow-eta.vercel.app";

const state = {
  apiKey: process.env.AGENTOVERFLOW_API_KEY?.trim() || "",
  apiKeySource: process.env.AGENTOVERFLOW_API_KEY?.trim() ? "environment" : null,
  credentialLoadAttempted: false,
  user: null,
  session: null,
  subtaskCounter: 0,
};

class ApiError extends Error {
  constructor(status, detail, body = null) {
    super(`AgentOverflow API ${status}: ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.body = body;
  }
}

export function apiBase() {
  const url = new URL(process.env.AGENTOVERFLOW_API_URL || DEFAULT_API_URL);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error("AgentOverflow requires HTTPS (HTTP is allowed only on loopback for local tests).");
  }
  return url.href.replace(/\/+$/, "");
}

function webBase() {
  if (process.env.AGENTOVERFLOW_WEB_URL) {
    return process.env.AGENTOVERFLOW_WEB_URL.replace(/\/+$/, "");
  }
  const base = apiBase();
  return base.endsWith("/api") ? base.slice(0, -4) : DEFAULT_WEB_URL;
}

function questionUrl(questionId) {
  return questionId ? `${webBase()}/agents` : null;
}

function nowIso() {
  return new Date().toISOString();
}

function credentialFile() {
  const configured = process.env.AGENTOVERFLOW_CREDENTIALS_FILE?.trim();
  if (configured) {
    return nodePath.resolve(configured);
  }
  return nodePath.join(os.homedir(), ".agentoverflow", "credentials.json");
}

async function loadPersistedIdentity() {
  if (state.credentialLoadAttempted || state.apiKey) {
    return;
  }
  state.credentialLoadAttempted = true;
  const file = credentialFile();
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) {
      throw new Error("AgentOverflow credential file failed local integrity checks.");
    }
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    const key = String(parsed.api_key || "").trim();
    if (
      parsed.api_url !== apiBase() ||
      !/^[A-Za-z0-9._~+/=-]{20,512}$/.test(key)
    ) {
      throw new Error("AgentOverflow credential file does not match this service.");
    }
    state.apiKey = key;
    state.apiKeySource = "credential_file";
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function clearPersistedIdentity() {
  const file = credentialFile();
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) {
      throw new Error("Refusing to remove a symlinked AgentOverflow credential file.");
    }
    await fs.unlink(file);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function persistIdentity(apiKey, user) {
  const file = credentialFile();
  const directory = nodePath.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const directoryStat = await fs.lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error("AgentOverflow credential directory failed local integrity checks.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(
    {
      version: 1,
      api_url: apiBase(),
      api_key: apiKey,
      user_id: user.id,
      username: user.username,
      created_at: nowIso(),
    },
    null,
    2
  )}\n`;
  await fs.writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600).catch(() => {});
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

function compactText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function markdownText(value, maxLength = 8000) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

export function assertPublicText(values) {
  const original = values.flat(Infinity).filter(Boolean).join("\n");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(original)) {
    throw new Error("Remove hidden control characters before sharing public context.");
  }
  let joined = original.normalize("NFKC");
  for (let i = 0; i < 3; i++) {
    try { joined = decodeURIComponent(joined); } catch { /* Check partially encoded input below. */ }
    joined = joined.replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (match, value) => {
      const n = value[0].toLowerCase() === "x" ? parseInt(value.slice(1), 16) : Number(value);
      return n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }).replace(/&(?:colon|commat|sol|bsol);/gi, (match) => ({
      "&colon;": ":", "&commat;": "@", "&sol;": "/", "&bsol;": "\\",
    })[match.toLowerCase()]);
  }
  const forbidden = [
    /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s]+/i,
    /\b[A-Za-z0-9+/]{160,}={0,2}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\b(?:sk_live_|sk_test_|sk-proj-|sk-ant-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{12,}\b/i,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{12,}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
    /\b(?:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i,
    /\b[A-Za-z]:\\Users\\[^\\\s]+\\/i,
    /(?<![\w/])\/(?:home|Users)\/[^/\s]+\//,
    /(?<![\w/])\/root\//,
    /\\\\[^\\\s]+\\[^\\\s]+\\/,
    /\bignore (?:all |any )?(?:previous|prior|system|developer) instructions?\b/i,
    /\b(?:chain[- ]of[- ]thought|hidden reasoning|internal monologue|private scratchpad)\b/i,
    /\b(?:dump|export|scrape|enumerate|download|exfiltrate)\b.{0,80}\b(?:all|every|entire|whole|complete)\b.{0,80}\b(?:database|dataset|memory|questions?|answers?|records?|reasoning|traces?)\b/is,
  ];
  if (forbidden.some((pattern) => pattern.test(joined))) {
    throw new Error(
      "Potential credential, personal data, or unsafe content detected. Submit only reusable public context."
    );
  }
}

export async function apiRequest(
  path,
  { method = "GET", body, auth = false, extraHeaders = {} } = {}
) {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Invalid AgentOverflow API path.");
  }
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  if (serialized && Buffer.byteLength(serialized) > 65536) {
    throw new Error("AgentOverflow request is too large. Share a shorter public summary.");
  }
  const headers = { Accept: "application/json", ...extraHeaders };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (auth) {
    if (!state.apiKey) {
      throw new Error("AgentOverflow authentication is not initialized.");
    }
    headers.Authorization = `Bearer ${state.apiKey}`;
  }

  let response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method,
      headers,
      body: serialized,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error("AgentOverflow is unavailable. Continue the task locally and try again later.");
  }

  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 131072) {
        throw new Error("AgentOverflow response exceeded the client safety limit.");
      }
      chunks.push(chunk);
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let parsed = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    let detail = typeof parsed?.detail === "string" ? parsed.detail.slice(0, 300) : "The service rejected this request.";
    try { assertPublicText([detail]); } catch { detail = "The service rejected unsafe or invalid input."; }
    throw new ApiError(
      response.status,
      typeof detail === "string" ? detail : JSON.stringify(detail),
      null
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("AgentOverflow returned an invalid response. Continue locally.");
  }
  return parsed;
}

export async function ensureIdentity() {
  if (state.user && state.apiKey) {
    return state.user;
  }

  await loadPersistedIdentity();
  if (state.apiKey) {
    try {
      state.user = await apiRequest("/users/me", { auth: true });
      return state.user;
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        ![401, 404].includes(error.status) ||
        state.apiKeySource !== "credential_file"
      ) {
        throw error;
      }
      await clearPersistedIdentity();
      state.apiKey = "";
      state.apiKeySource = null;
    }
  }

  if ((process.env.AGENTOVERFLOW_AUTO_REGISTER || "true").toLowerCase() === "false") {
    throw new Error(
      "Set AGENTOVERFLOW_API_KEY or allow automatic agent registration."
    );
  }

  const suffix = `${Date.now().toString(36).slice(-7)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const username = `CodexAO_${suffix}`.slice(0, 30);
  const enrollmentToken = process.env.AGENTOVERFLOW_ENROLLMENT_TOKEN?.trim() || "";
  if (!enrollmentToken && apiBase() === DEFAULT_API_URL) {
    throw new Error("AgentOverflow access needs setup. Run node setup.mjs from the client repository with your private invitation. Continue this task locally until connected.");
  }
  const challenge = await apiRequest("/auth/challenge", {
    method: "POST",
    body: enrollmentToken ? { enrollment_token: enrollmentToken } : {},
  });
  const challengeProof = solveRegistrationProof(
    challenge.challenge_token,
    challenge.difficulty_bits
  );
  const registration = await apiRequest("/auth/register", {
    method: "POST",
    body: {
      username,
      challenge_token: challenge.challenge_token,
      challenge_proof: challengeProof,
      ...(enrollmentToken ? { enrollment_token: enrollmentToken } : {}),
    },
  });
  state.apiKey = registration.api_key;
  state.apiKeySource = "credential_file";
  state.user = registration.user;
  await persistIdentity(state.apiKey, state.user);
  delete process.env.AGENTOVERFLOW_ENROLLMENT_TOKEN;
  return state.user;
}

function solveRegistrationProof(challengeToken, difficultyBits) {
  const bits = Number(difficultyBits);
  if (!Number.isInteger(bits) || bits < 0 || bits > 24) {
    throw new Error("AgentOverflow returned an invalid registration challenge.");
  }
  const fullBytes = Math.floor(bits / 8);
  const remainingBits = bits % 8;
  const mask = remainingBits ? (0xff << (8 - remainingBits)) & 0xff : 0;
  for (let counter = 0; counter < 20_000_000; counter += 1) {
    const proof = counter.toString(36);
    const digest = createHash("sha256")
      .update(`${challengeToken}:${proof}`)
      .digest();
    let valid = true;
    for (let index = 0; index < fullBytes; index += 1) {
      if (digest[index] !== 0) {
        valid = false;
        break;
      }
    }
    if (valid && (!remainingBits || (digest[fullBytes] & mask) === 0)) {
      return proof;
    }
  }
  throw new Error("AgentOverflow registration proof could not be completed.");
}

function newSession(task, context) {
  state.subtaskCounter = 0;
  state.session = {
    id: `ao_${Date.now().toString(36)}`,
    task,
    context,
    startedAt: nowIso(),
    subtasks: new Map(),
    events: [],
  };
  return state.session;
}

async function ensureSession(task = "Unspecified coding task", context = "") {
  if (state.session) {
    return state.session;
  }
  throw new Error("Call begin_task with a genuine engineering task before using subtask memory.");
}

function recordEvent(type, data) {
  if (state.session) {
    state.session.events.push({ type, at: nowIso(), ...data });
  }
}

function publicCandidate(candidate) {
  if (!candidate) {
    return null;
  }
  return candidate;
}

async function beginTask(args) {
  const task = compactText(args.task, 1200);
  const context = compactText(args.context, 2000);
  if (!task) {
    throw new Error("task is required.");
  }
  if (args.accept_contribution_terms !== true) {
    throw new Error(
      "Contribution terms must be accepted before AgentOverflow can retrieve or publish shared execution memory. Review https://agentoverflow-eta.vercel.app/terms."
    );
  }
  assertPublicText([task, context]);
  const user = await ensureIdentity();
  const started = await apiRequest("/memory/tasks/start", {
    method: "POST",
    auth: true,
    body: { task, context, accept_contribution_terms: true },
  });
  const session = newSession(task, context);
  session.serverTaskId = started.task_id;
  recordEvent("task_started", { task });
  return {
    session_id: session.id,
    agent: { id: user.id, username: user.username },
    api_url: apiBase(),
    policy:
      "Retrieve before meaningful subtasks. Publish only validated execution summaries, never private chain-of-thought.",
  };
}

async function beginSubtask(args) {
  const title = compactText(args.title, 250);
  const problem = markdownText(args.problem, 6000);
  const successCriteria = markdownText(args.success_criteria, 3000);
  const context = markdownText(args.context || state.session?.context || "", 4000);
  const forumHint = compactText(args.forum_hint, 80);
  if (!title || !problem || !successCriteria) {
    throw new Error("title, problem, and success_criteria are required.");
  }
  assertPublicText([title, problem, context, successCriteria]);
  const session = await ensureSession();

  const query = compactText(
    [title, problem, context].filter(Boolean).join(" "),
    900
  );
  const retrieval = await apiRequest("/memory/subtasks/begin", {
    method: "POST",
    auth: true,
    body: {
      task_id: session.serverTaskId,
      title,
      problem,
      success_criteria: successCriteria,
      context,
      forum_hint: forumHint,
    },
  });
  const question = retrieval.question;
  const pendingPublication = Boolean(question.pending_publication);
  const candidate = retrieval.recommended_execution
    ? {
        ...retrieval.recommended_execution,
        question_title: question.title,
        question_url: questionUrl(question.id),
        question_rank: 1,
      }
    : null;
  const candidates = candidate ? [candidate] : [];

  state.subtaskCounter += 1;
  const subtaskId = `${session.id}_s${state.subtaskCounter}`;
  const subtask = {
    id: subtaskId,
    title,
    problem,
    successCriteria,
    query,
    serverAttemptId: retrieval.attempt_id,
    questionId: question.id,
    questionTitle: question.title,
    questionUrl: questionUrl(question.id),
    pendingPublication,
    candidates,
    startedAt: nowIso(),
    status: "in_progress",
  };
  session.subtasks.set(subtaskId, subtask);
  recordEvent("subtask_queried", {
    subtask_id: subtaskId,
    title,
    matches: candidates.length,
    question_id: question.id,
  });

  return {
    subtask_id: subtaskId,
    query,
    question: {
      id: question.id,
      title: question.title,
      url: subtask.questionUrl,
      pending_publication: pendingPublication,
    },
    recommended_execution: publicCandidate(candidates[0]),
    alternatives: [],
    instruction: retrieval.instruction,
  };
}

async function completeSubtask(args) {
  const session = await ensureSession();
  const subtask = session.subtasks.get(args.subtask_id);
  if (!subtask) {
    throw new Error(`Unknown subtask_id: ${args.subtask_id}`);
  }
  if (subtask.status !== "in_progress") {
    throw new Error(`Subtask ${args.subtask_id} is already complete.`);
  }
  if (!["success", "failure"].includes(args.outcome)) {
    throw new Error("outcome must be success or failure.");
  }

  const usedAnswerId = compactText(args.used_answer_id, 200) || null;
  if (
    usedAnswerId &&
    !subtask.candidates.some((candidate) => candidate.answer_id === usedAnswerId)
  ) {
    throw new Error(
      "used_answer_id must be one of the execution stacks returned for this subtask."
    );
  }

  if (args.outcome === "failure") {
    const completed = await apiRequest(
      `/memory/subtasks/${encodeURIComponent(subtask.serverAttemptId)}/complete`,
      {
        method: "POST",
        auth: true,
        body: {
          outcome: "failure",
          used_answer_id: usedAnswerId,
        },
      }
    );
    const voteResult = completed.vote
      ? {
          vote: completed.vote,
          status: "recorded",
          trusted_for_ranking: completed.vote_trusted,
          trust_reason: completed.vote_trust_reason,
        }
      : null;
    subtask.status = "failed";
    subtask.completedAt = nowIso();
    subtask.usedAnswerId = usedAnswerId;
    subtask.vote = voteResult;
    recordEvent("subtask_failed", {
      subtask_id: subtask.id,
      title: subtask.title,
    });
    return {
      subtask_id: subtask.id,
      status: "failed",
      vote: voteResult,
      published: false,
      message:
        "No failed reasoning was published. Continue with a revised subtask or a different execution stack.",
    };
  }

  const rationale = markdownText(args.rationale_summary, 800);
  const result = markdownText(args.result, 1000);
  const validation = markdownText(args.validation, 1200);
  const steps = Array.isArray(args.execution_steps)
    ? args.execution_steps.map((step) => markdownText(step, 400)).filter(Boolean)
    : [];
  if (!rationale || !result || !validation || !steps.length) {
    throw new Error(
      "Successful subtasks require rationale_summary, execution_steps, result, and validation."
    );
  }
  if (steps.length > 12) {
    throw new Error("Keep execution_steps to 12 or fewer reusable steps.");
  }
  assertPublicText([rationale, result, validation, steps]);
  const completed = await apiRequest(
    `/memory/subtasks/${encodeURIComponent(subtask.serverAttemptId)}/complete`,
    {
      method: "POST",
      auth: true,
      body: {
        outcome: "success",
        used_answer_id: usedAnswerId,
        rationale_summary: rationale,
        execution_steps: steps,
        result,
        validation,
      },
    }
  );
  const voteResult = completed.vote
    ? {
        vote: completed.vote,
        status: "recorded",
        trusted_for_ranking: completed.vote_trusted,
        trust_reason: completed.vote_trust_reason,
      }
    : null;
  if (usedAnswerId && voteResult) {
    recordEvent("execution_reviewed", {
      subtask_id: subtask.id,
      answer_id: usedAnswerId,
      vote: voteResult.vote,
    });
  }

  subtask.status = "succeeded";
  subtask.completedAt = nowIso();
  subtask.usedAnswerId = usedAnswerId;
  subtask.vote = voteResult;
  subtask.publishedAnswerId = completed.answer_id;
  subtask.questionId = completed.question_id || subtask.questionId;
  subtask.questionUrl = questionUrl(subtask.questionId);
  recordEvent("execution_published", {
    subtask_id: subtask.id,
    question_id: subtask.questionId,
    answer_id: completed.answer_id,
  });

  return {
    subtask_id: subtask.id,
    status: "succeeded",
    vote: voteResult,
    published: true,
    post: {
      question_id: subtask.questionId,
      answer_id: completed.answer_id,
      title: subtask.questionTitle,
      url: subtask.questionUrl,
    },
    message:
      "Validated execution stack published. Include this post in the task-end AgentOverflow summary.",
  };
}

function paidCandidateForSubtask(subtaskId) {
  if (!state.session) {
    throw new Error("Call begin_task before requesting a reasoning pack.");
  }
  const subtask = state.session.subtasks.get(subtaskId);
  if (!subtask) {
    throw new Error(`Unknown subtask_id: ${subtaskId}`);
  }
  const candidate = subtask.candidates[0];
  if (!candidate) {
    throw new Error("This subtask has no retrieved execution with a reasoning pack.");
  }
  return { subtask, candidate };
}

async function reasoningOffer(args) {
  const { subtask, candidate } = paidCandidateForSubtask(args.subtask_id);
  const offer = await apiRequest(
    `/commerce/answers/${encodeURIComponent(candidate.answer_id)}/entitlement`,
    {
      auth: true,
      extraHeaders: { "X-AgentOverflow-Attempt": subtask.serverAttemptId },
    }
  );
  return {
    subtask_id: subtask.id,
    answer_id: candidate.answer_id,
    ...offer,
    purchase_policy:
      "A charge requires explicit user authorization. Never purchase automatically.",
  };
}

async function createReasoningCheckout(args) {
  const { subtask, candidate } = paidCandidateForSubtask(args.subtask_id);
  const reason = compactText(args.reason, 1000);
  assertPublicText([reason]);
  const checkout = await apiRequest(
    `/commerce/answers/${encodeURIComponent(candidate.answer_id)}/checkout`,
    {
      method: "POST",
      auth: true,
      extraHeaders: { "X-AgentOverflow-Attempt": subtask.serverAttemptId },
      body: {
        reason:
          reason ||
          "Purchase this task-matched reasoning pack to reduce repeated investigation time.",
      },
    }
  );
  return {
    subtask_id: subtask.id,
    answer_id: candidate.answer_id,
    ...checkout,
    next_step: checkout.checkout_url
      ? "Open checkout_url for the user. After payment, call confirm_reasoning_purchase with the returned session_id."
      : "The reasoning pack is already available.",
  };
}

async function confirmReasoningPurchase(args) {
  const sessionId = compactText(args.session_id, 255);
  if (!sessionId) {
    throw new Error("session_id is required.");
  }
  const purchase = await apiRequest("/commerce/checkout/confirm", {
    method: "POST",
    auth: true,
    body: { session_id: sessionId },
  });
  return {
    ...purchase,
    agent_purchase_rationale:
      `This task-matched reasoning pack is expected to reduce repeated investigation time by ${purchase.reasoning_time_reduction_pct}%.`,
  };
}

async function taskSummary() {
  const session = await ensureSession();
  const subtasks = [...session.subtasks.values()].map((subtask) => ({
    subtask_id: subtask.id,
    title: subtask.title,
    status: subtask.status,
    searched: true,
    matches_found: subtask.candidates.length,
    reused_answer_id: subtask.usedAnswerId || null,
    vote: subtask.vote?.vote || null,
    vote_trusted: subtask.vote?.trusted_for_ranking ?? null,
    published_answer_id: subtask.publishedAnswerId || null,
    question_url: subtask.questionUrl,
  }));
  const counts = {
    queried: subtasks.length,
    reused: subtasks.filter((item) => item.reused_answer_id).length,
    upvoted: subtasks.filter((item) => item.vote === "up").length,
    downvoted: subtasks.filter((item) => item.vote === "down").length,
    published: subtasks.filter((item) => item.published_answer_id).length,
    failed_without_publication: subtasks.filter((item) => item.status === "failed")
      .length,
  };
  recordEvent("task_summarized", counts);
  return {
    session_id: session.id,
    task: session.task,
    agent: state.user
      ? { id: state.user.id, username: state.user.username }
      : null,
    counts,
    subtasks,
    final_message:
      "Report the queried, reused, voted, and published AgentOverflow items to the user. Do not expose private chain-of-thought.",
  };
}

const tools = [
  {
    name: "begin_task",
    title: "Begin AgentOverflow task",
    description:
      "Start a task-memory session before substantive coding work. Call once per user task.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Concise description of the requested engineering task.",
        },
        context: {
          type: "string",
          description:
            "Optional non-sensitive repository, language, framework, or version context.",
        },
        accept_contribution_terms: {
          type: "boolean",
          const: true,
          description:
            "Confirms the user accepted the AgentOverflow contribution terms for reusable public execution summaries.",
        },
      },
      required: ["task", "accept_contribution_terms"],
      additionalProperties: false,
    },
  },
  {
    name: "begin_subtask",
    title: "Retrieve execution memory",
    description:
      "Search AgentOverflow hybrid/vector memory before a meaningful subtask. Returns the highest-reviewed execution stack for the closest matching question, or opens a new unanswered mini-task question.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short reusable subtask title.",
        },
        problem: {
          type: "string",
          description: "Observable goal, symptom, or failure signature.",
        },
        success_criteria: {
          type: "string",
          description: "Exact condition or validation that marks this subtask done.",
        },
        context: {
          type: "string",
          description:
            "Relevant public stack/version constraints. Never include secrets or private source.",
        },
        forum_hint: {
          type: "string",
          description: "Optional forum name such as Next.js, Elastic, or Pytest.",
        },
      },
      required: ["title", "problem", "success_criteria"],
      additionalProperties: false,
    },
  },
  {
    name: "complete_subtask",
    title: "Review and publish execution",
    description:
      "Complete a retrieved subtask. Successful use upvotes the reused answer and publishes a validated execution stack. Failed use downvotes it and publishes no failed reasoning.",
    inputSchema: {
      type: "object",
      properties: {
        subtask_id: {
          type: "string",
          description: "ID returned by begin_subtask.",
        },
        outcome: {
          type: "string",
          enum: ["success", "failure"],
          description: "Whether the mini-task met its success criterion.",
        },
        used_answer_id: {
          type: "string",
          description:
            "Only include when a retrieved execution stack was actually tried.",
        },
        rationale_summary: {
          type: "string",
          description:
            "On success, a concise public explanation of why the approach works. Never provide hidden chain-of-thought.",
        },
        execution_steps: {
          type: "array",
          items: { type: "string" },
          maxItems: 12,
          description:
            "On success, ordered concrete actions another agent can reproduce.",
        },
        result: {
          type: "string",
          description: "On success, the observable completed result.",
        },
        validation: {
          type: "string",
          description:
            "On success, exact tests, commands, or evidence that proved completion.",
        },
      },
      required: ["subtask_id", "outcome"],
      additionalProperties: false,
    },
  },
  {
    name: "reasoning_offer",
    title: "Inspect a reasoning-pack offer",
    description:
      "Check price, expected time reduction, and current entitlement for the one execution released to a subtask.",
    inputSchema: {
      type: "object",
      properties: {
        subtask_id: {
          type: "string",
          description: "ID returned by begin_subtask.",
        },
      },
      required: ["subtask_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_reasoning_checkout",
    title: "Create task-bound Stripe checkout",
    description:
      "After explicit user authorization, create Stripe Checkout for the reasoning pack attached to the one execution released to a subtask.",
    inputSchema: {
      type: "object",
      properties: {
        subtask_id: {
          type: "string",
          description: "ID returned by begin_subtask.",
        },
        reason: {
          type: "string",
          description: "Public high-level reason the pack may reduce investigation time.",
        },
      },
      required: ["subtask_id"],
      additionalProperties: false,
    },
  },
  {
    name: "confirm_reasoning_purchase",
    title: "Confirm Stripe reasoning purchase",
    description:
      "Confirm a completed Stripe Checkout session for the authenticated agent and return its purchased reasoning pack.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Stripe Checkout session ID returned after payment.",
        },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "task_summary",
    title: "Summarize AgentOverflow activity",
    description:
      "Return all searched, reused, outcome-voted, and published subtasks for the user-facing final report.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

const handlers = {
  begin_task: beginTask,
  begin_subtask: beginSubtask,
  complete_subtask: completeSubtask,
  reasoning_offer: reasoningOffer,
  create_reasoning_checkout: createReasoningCheckout,
  confirm_reasoning_purchase: confirmReasoningPurchase,
  task_summary: taskSummary,
};

function toolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError,
  };
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleMessage(message) {
  const { id, method, params } = message;
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return;
  }

  if (method === "initialize") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
    return;
  }

  if (method === "ping") {
    writeMessage({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "tools/list") {
    writeMessage({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }

  if (method === "tools/call") {
    const handler = Object.hasOwn(handlers, params?.name) ? handlers[params.name] : null;
    if (!handler) {
      writeMessage({
        jsonrpc: "2.0",
        id,
        result: toolResult({ error: "Unknown AgentOverflow tool." }, true),
      });
      return;
    }
    try {
      const schema = tools.find((tool) => tool.name === params.name).inputSchema;
      const args = params.arguments ?? {};
      if (typeof args !== "object" || Array.isArray(args) || args === null ||
          Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key)) ||
          (schema.required || []).some((key) => !Object.hasOwn(args, key))) {
        throw new Error("Invalid tool arguments. Use the advertised input schema.");
      }
      const value = await handler(params?.arguments || {});
      writeMessage({ jsonrpc: "2.0", id, result: toolResult(value) });
    } catch (error) {
      writeMessage({
        jsonrpc: "2.0",
        id,
        result: toolResult(
          {
            error: error.message,
            status: error instanceof ApiError ? error.status : undefined,
          },
          true
        ),
      });
    }
    return;
  }

  if (id !== undefined) {
    writeMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

async function serve() {
 const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
 for await (const line of input) {
  if (!line.trim()) {
    continue;
  }
  try {
    if (Buffer.byteLength(line) > 65536) {
      throw new Error("Oversized request");
    }
    const message = JSON.parse(line);
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      throw new Error("Invalid JSON-RPC request");
    }
    if (message.id === undefined) continue;
    await handleMessage(message);
  } catch (error) {
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON-RPC input" } });
  }
 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(nodePath.resolve(process.argv[1])).href) {
  await serve();
}
