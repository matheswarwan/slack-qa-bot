var GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
var GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive"
].join(" ");
function base64url(bytes) {
  let str = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
  return btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function strToBase64url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
async function importPrivateKey(pem) {
  const pemBody = pem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\\n/g, "").replace(/\s/g, "");
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}
async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1e3);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: env.GOOGLE_SA_CLIENT_EMAIL,
    scope: GOOGLE_SCOPES,
    aud: GOOGLE_TOKEN_URI,
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${strToBase64url(JSON.stringify(header))}.${strToBase64url(JSON.stringify(claims))}`;
  const key = await importPrivateKey(env.GOOGLE_SA_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64url(signature)}`;
  const res = await fetch(GOOGLE_TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("Error minting Google access token:", data);
    throw new Error(data.error_description || data.error || "Token exchange failed");
  }
  return data.access_token;
}
async function verifySlackRequest(body, request, env) {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const slackSignature = request.headers.get("x-slack-signature");
  if (!timestamp || !slackSignature) {
    console.log("Missing timestamp or signature");
    return false;
  }
  const time = Math.floor((new Date()).getTime() / 1e3);
  if (Math.abs(time - timestamp) > 60 * 5) {
    console.log("Request too old");
    return false;
  }
  const sigBaseString = `v0:${timestamp}:${body}`;
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    new TextEncoder().encode(sigBaseString)
  );
  const hexSignature = `v0=${Array.prototype.map.call(new Uint8Array(signatureBuffer), (x) => x.toString(16).padStart(2, "0")).join("")}`;
  return slackSignature === hexSignature;
}
async function driveGetJson(accessToken, url) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json();
  if (!response.ok) {
    console.error("Drive API error:", data);
    throw new Error(data.error?.message || "Drive API request failed");
  }
  return data;
}
async function getQaOutputFolderId(accessToken, templateId) {
  const template = await driveGetJson(
    accessToken,
    `https://www.googleapis.com/drive/v3/files/${templateId}?fields=parents&supportsAllDrives=true`
  );
  const templateFolderId = template.parents?.[0];
  if (!templateFolderId) {
    throw new Error("Template has no parent folder");
  }
  const templateFolder = await driveGetJson(
    accessToken,
    `https://www.googleapis.com/drive/v3/files/${templateFolderId}?fields=parents&supportsAllDrives=true`
  );
  return templateFolder.parents?.[0] || templateFolderId;
}
async function copyGoogleSheet(accessToken, templateId, title) {
  const outputFolderId = await getQaOutputFolderId(accessToken, templateId);
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${templateId}/copy?supportsAllDrives=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: title,
        parents: [outputFolderId]
      })
    }
  );
  const sheetData = await response.json();
  if (!response.ok) {
    console.error("Error cloning Google Sheet:", sheetData);
    throw new Error(sheetData.error?.message || "Failed to clone template sheet");
  }
  console.log(`Cloned template ${templateId} -> ${sheetData.id} in folder ${outputFolderId}`);
  return sheetData.id;
}
async function shareGoogleSheet(accessToken, spreadsheetId, email) {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions?supportsAllDrives=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        role: "writer",
        type: "user",
        emailAddress: email
      })
    }
  );
  const shareResponse = await response.json();
  if (!response.ok) {
    console.error("Error sharing Google Sheet:", shareResponse);
    throw new Error(shareResponse.error?.message || "Failed to share sheet");
  }
  console.log(`Shared Google Sheet with ${email}`);
}
async function shareGoogleSheetWithRetry(accessToken, spreadsheetId, email, maxAttempts = 4) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await shareGoogleSheet(accessToken, spreadsheetId, email);
      return;
    } catch (err) {
      const retryable = /not found/i.test(err.message) && attempt < maxAttempts;
      if (!retryable) throw err;
      console.log(`Share attempt ${attempt} failed (file not ready), retrying...`);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}
async function sendSlackMessage(env, channelId, message, blocks) {
  const body = { channel: channelId, text: message };
  if (blocks) body.blocks = blocks;
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const slackResponse = await response.json();
  if (!response.ok || !slackResponse.ok) {
    console.error("Error sending Slack message:", slackResponse);
    throw new Error(slackResponse.error || "Failed to send message");
  }
  console.log(`Message sent to channel: ${channelId}`);
}
function encodeTaskPayload(task) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(task))));
}
function decodeTaskPayload(value) {
  return JSON.parse(decodeURIComponent(escape(atob(value))));
}
function newTaskId() {
  return crypto.randomUUID();
}
async function claimTask(env, taskId) {
  if (!env.TASK_STATE || !taskId) return true;
  const key = `task:${taskId}`;
  const existing = await env.TASK_STATE.get(key);
  if (existing) return false;
  await env.TASK_STATE.put(key, "processing", { expirationTtl: 3600 });
  return true;
}
async function completeTask(env, taskId, spreadsheetId) {
  if (!env.TASK_STATE || !taskId) return;
  await env.TASK_STATE.put(keyForTask(taskId), spreadsheetId, { expirationTtl: 86400 });
}
async function failTask(env, taskId) {
  if (!env.TASK_STATE || !taskId) return;
  await env.TASK_STATE.delete(keyForTask(taskId));
}
function keyForTask(taskId) {
  return `task:${taskId}`;
}
function buildTaskAcceptRejectBlocks(task) {
  const payload = encodeTaskPayload(task);
  let details = `<@${task.a}> *New QA task assignment*
*Project:* ${task.p}
*Task:* ${task.t}
*Deadline:* ${task.d}`;
  if (task.n) details += `
*Notes:* ${task.n}`;
  details += `
*Requested by:* <@${task.r}>`;
  return [
    { type: "section", block_id: "qa_task_details", text: { type: "mrkdwn", text: details } },
    {
      type: "section",
      block_id: "qa_task_prompt",
      text: { type: "mrkdwn", text: "Do you accept this task?" }
    },
    {
      type: "actions",
      block_id: "qa_task_response",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Accept" },
          style: "primary",
          action_id: QA_ACCEPT_ACTION,
          value: payload
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: QA_REJECT_ACTION,
          value: payload
        }
      ]
    }
  ];
}
function buildStatusBlocks(originalBlocks, statusText) {
  const contentBlocks = (originalBlocks || []).filter(
    (b) => b.type !== "actions" && b.block_id !== "qa_task_response" && b.block_id !== "qa_task_prompt"
  );
  return [
    ...contentBlocks,
    {
      type: "context",
      block_id: "qa_task_status",
      elements: [{ type: "mrkdwn", text: statusText }]
    }
  ];
}
async function postToResponseUrl(responseUrl, body) {
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    console.error("Error posting to response_url:", await response.text());
  }
}
async function updateInteractionMessage(responseUrl, originalBlocks, statusText, fallbackText) {
  await postToResponseUrl(responseUrl, {
    replace_original: true,
    blocks: buildStatusBlocks(originalBlocks, statusText),
    text: fallbackText
  });
}
async function getSlackUserEmail(env, userId) {
  const response = await fetch(
    `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } }
  );
  const data = await response.json();
  if (!data.ok) {
    console.error("Error looking up Slack user:", data);
    throw new Error(data.error || "Failed to look up user");
  }
  const email = data.user?.profile?.email;
  if (!email) {
    throw new Error("User has no email (is the users:read.email scope granted?)");
  }
  return email;
}
async function getChannelMemberOptions(env, channelId) {
  const membersRes = await fetch(
    `https://slack.com/api/conversations.members?channel=${encodeURIComponent(channelId)}&limit=200`,
    { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } }
  );
  const membersData = await membersRes.json();
  if (!membersData.ok) {
    console.error("Error fetching channel members:", membersData);
    throw new Error(membersData.error || "Failed to fetch channel members");
  }
  const memberIds = (membersData.members || []).slice(0, 100);
  const infos = await Promise.all(
    memberIds.map(
      (id) => fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` }
      }).then((r) => r.json()).catch(() => ({ ok: false }))
    )
  );
  const options = [];
  for (const info of infos) {
    if (!info.ok || !info.user) continue;
    const u = info.user;
    if (u.is_bot || u.deleted || u.id === "USLACKBOT") continue;
    const name = u.profile?.display_name || u.profile?.real_name || u.name || u.id;
    options.push({ text: { type: "plain_text", text: name.slice(0, 75) }, value: u.id });
  }
  return options;
}
var QA_MODAL_CALLBACK_ID = "qa_form_submit";
var QA_ACCEPT_ACTION = "qa_task_accept";
var QA_REJECT_ACTION = "qa_task_reject";
// QA types and their Google Sheet checklist templates, from the QA_TEMPLATES
// variable: a JSON array like [{"label": "Email Send", "templateId": "<sheet id>"}].
function getQaTemplates(env) {
  try {
    const list = JSON.parse(env.QA_TEMPLATES || "[]");
    return Array.isArray(list) ? list.filter((t) => t && t.label && t.templateId) : [];
  } catch (err) {
    console.error("QA_TEMPLATES is not valid JSON:", err.message);
    return [];
  }
}
function buildQaTaskOptions(env) {
  return getQaTemplates(env).map((t) => ({
    text: { type: "plain_text", text: t.label },
    value: t.templateId
  }));
}
function buildQaSheetTitle(projectName, qaTask, targetDate) {
  const datePrefix = targetDate ? `${targetDate} - ` : "";
  return `${datePrefix}${projectName} - ${qaTask} QA`;
}
function buildAssigneeElement(assigneeOptions) {
  if (assigneeOptions && assigneeOptions.length > 0) {
    return {
      type: "static_select",
      action_id: "assignee_input",
      placeholder: { type: "plain_text", text: "Select a person" },
      options: assigneeOptions
    };
  }
  return {
    type: "users_select",
    action_id: "assignee_input",
    placeholder: { type: "plain_text", text: "Select a person" }
  };
}
function buildQaModalView(assigneeOptions, channelId, env) {
  return {
    type: "modal",
    callback_id: QA_MODAL_CALLBACK_ID,
    private_metadata: channelId,
    title: { type: "plain_text", text: "New QA Task" },
    submit: { type: "plain_text", text: "Create" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "assignee_block",
        label: { type: "plain_text", text: "Assignee" },
        element: buildAssigneeElement(assigneeOptions)
      },
      {
        type: "input",
        block_id: "project_name_block",
        label: { type: "plain_text", text: "Project name" },
        element: { type: "plain_text_input", action_id: "project_name_input" }
      },
      {
        type: "input",
        block_id: "qa_task_block",
        label: { type: "plain_text", text: "QA task" },
        element: {
          type: "static_select",
          action_id: "qa_task_select",
          placeholder: { type: "plain_text", text: "Select a task type" },
          options: buildQaTaskOptions(env)
        }
      },
      {
        type: "input",
        block_id: "deadline_block",
        label: { type: "plain_text", text: "Deadline" },
        element: { type: "datepicker", action_id: "deadline_input" }
      },
      {
        type: "input",
        block_id: "notes_block",
        optional: true,
        label: { type: "plain_text", text: "Notes" },
        element: { type: "plain_text_input", action_id: "notes_input", multiline: true }
      }
    ]
  };
}
async function openQaModal(env, triggerId, channelId) {
  let assigneeOptions = [];
  try {
    assigneeOptions = await getChannelMemberOptions(env, channelId);
  } catch (err) {
    console.error("Could not scope assignees to channel, falling back:", err);
  }
  const response = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ trigger_id: triggerId, view: buildQaModalView(assigneeOptions, channelId, env) })
  });
  const data = await response.json();
  if (!data.ok) {
    console.error("Error opening modal:", data);
    throw new Error(data.error || "Failed to open modal");
  }
}
async function handleQaSubmission(env, payload) {
  const values = payload.view.state.values;
  const assigneeInput = values.assignee_block.assignee_input;
  const assignee = assigneeInput.selected_option?.value || assigneeInput.selected_user;
  const projectName = values.project_name_block.project_name_input.value;
  const taskOption = values.qa_task_block.qa_task_select.selected_option;
  const qaTask = taskOption?.text?.text;
  const templateId = taskOption?.value;
  const deadline = values.deadline_block.deadline_input.selected_date;
  const notes = values.notes_block.notes_input.value || "";
  const requesterId = payload.user.id;
  const channelId = payload.view.private_metadata;
  const taskPayload = {
    id: newTaskId(),
    a: assignee,
    p: projectName,
    t: qaTask,
    tid: templateId,
    d: deadline,
    n: notes,
    r: requesterId,
    c: channelId
  };
  const blocks = buildTaskAcceptRejectBlocks(taskPayload);
  await sendSlackMessage(
    env,
    channelId,
    `<@${assignee}> You've been assigned a QA task: ${qaTask} for ${projectName}. Please accept or reject.`,
    blocks
  );
  console.log(`Accept/Reject prompt posted in channel ${channelId} for ${projectName}`);
}
async function handleTaskAccept(env, payload, task, assigneeId, originalBlocks) {
  if (assigneeId !== task.a) {
    throw new Error("Only the assigned user can accept this task");
  }
  const accessToken = await getGoogleAccessToken(env);
  const newSheetTitle = buildQaSheetTitle(task.p, task.t, task.d);
  const spreadsheetId = await copyGoogleSheet(accessToken, task.tid, newSheetTitle);
  const assigneeEmail = await getSlackUserEmail(env, assigneeId);
  await shareGoogleSheetWithRetry(accessToken, spreadsheetId, assigneeEmail);
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
  const statusText = `\u2705 <@${assigneeId}> accepted \u2014 Google Sheet: ${sheetUrl}`;
  const fallbackText = `${task.t} QA accepted for ${task.p}`;
  await updateInteractionMessage(payload.response_url, originalBlocks, statusText, fallbackText);
  console.log(`Task accepted by ${assigneeId}, sheet ${spreadsheetId} created`);
  return spreadsheetId;
}
async function handleBlockAction(env, payload, ctx) {
  const action = payload.actions?.[0];
  if (!action) return new Response("", { status: 200 });
  if (action.action_id !== QA_ACCEPT_ACTION && action.action_id !== QA_REJECT_ACTION) {
    return new Response("", { status: 200 });
  }
  const task = decodeTaskPayload(action.value);
  const assigneeId = payload.user.id;
  const isAccept = action.action_id === QA_ACCEPT_ACTION;
  const originalBlocks = payload.message?.blocks || [];
  if (assigneeId !== task.a) {
    return slackActionResponse(
      buildStatusBlocks(originalBlocks, "Only the assigned user can accept or reject this task."),
      "Unauthorized action"
    );
  }
  const immediateStatus = isAccept ? `\u23F3 <@${assigneeId}> accepted \u2014 creating the Google Sheet...` : `\u274C <@${assigneeId}> rejected this task.`;
  if (!isAccept) {
    return slackActionResponse(buildStatusBlocks(originalBlocks, immediateStatus), immediateStatus);
  }
  ctx.waitUntil(
    (async () => {
      try {
        const claimed = await claimTask(env, task.id);
        if (!claimed) {
          const existing = task.id ? await env.TASK_STATE?.get(keyForTask(task.id)) : null;
          if (existing && existing !== "processing") {
            const sheetUrl = `https://docs.google.com/spreadsheets/d/${existing}`;
            await updateInteractionMessage(
              payload.response_url,
              originalBlocks,
              `\u2705 Sheet already created \u2014 Google Sheet: ${sheetUrl}`,
              "Sheet already created"
            );
          }
          console.log(`Duplicate accept ignored for task ${task.id}`);
          return;
        }
        const spreadsheetId = await handleTaskAccept(env, payload, task, assigneeId, originalBlocks);
        await completeTask(env, task.id, spreadsheetId);
      } catch (err) {
        console.error("Error handling task response:", err);
        await failTask(env, task.id);
        await updateInteractionMessage(
          payload.response_url,
          originalBlocks,
          `\u26A0\uFE0F Something went wrong: ${err.message}`,
          "Task processing failed"
        );
      }
    })()
  );
  return slackActionResponse(buildStatusBlocks(originalBlocks, immediateStatus), immediateStatus);
}
function slackActionResponse(blocks, fallbackText) {
  return new Response(JSON.stringify({ replace_original: true, blocks, text: fallbackText }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
async function handleRequest(request, env, ctx) {
  if (request.method === "GET") {
    return new Response("slack-qa-bot ok", { status: 200 });
  }
  if (request.method !== "POST") {
    return new Response("Not Found", { status: 404 });
  }
  try {
    const bodyText = await request.text();
    const isVerified = await verifySlackRequest(bodyText, request, env);
    if (!isVerified) {
      console.error("Slack signature verification failed");
      return new Response("Unauthorized", { status: 401 });
    }
    const formData = new URLSearchParams(bodyText);
    const rawPayload = formData.get("payload");
    if (rawPayload) {
      const payload = JSON.parse(rawPayload);
      console.log(`Slack interaction: type=${payload.type}, callback_id=${payload.view?.callback_id || "n/a"}`);
      if (payload.type === "block_actions") {
        return handleBlockAction(env, payload, ctx);
      }
      if (payload.type === "view_submission" && payload.view?.callback_id === QA_MODAL_CALLBACK_ID) {
        console.log("QA modal submitted. Sending Accept/Reject prompt.");
        ctx.waitUntil(
          handleQaSubmission(env, payload).catch(
            (err) => console.error("Error handling QA submission:", err)
          )
        );
        return new Response("", { status: 200 });
      }
      return new Response("", { status: 200 });
    }
    const command = formData.get("command");
    const userId = formData.get("user_id");
    const triggerId = formData.get("trigger_id");
    const channelId = formData.get("channel_id");
    console.log(`Command: ${command}, User ID: ${userId}, Channel: ${channelId}`);
    if (command === "/qa") {
      console.log("Command = /qa. Opening modal.");
      await openQaModal(env, triggerId, channelId);
      return new Response("", { status: 200 });
    }
    return new Response("No action taken", { status: 200 });
  } catch (error) {
    console.error("Error processing request:", error);
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};
