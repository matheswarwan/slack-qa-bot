console.log(process.env.CONFIG);

const { App, ExpressReceiver } = require("@slack/bolt");
const { google } = require("googleapis");
const express = require("express");
const bodyParser = require("body-parser");

let assigneeUserId = "";
let projectName = "";
let qaTask = "";
let deadlineDate = "";
let deadlineTime = "";
let deadline = "";
let notes = "";
let requestorEmail = "";
let assigneeEmail = "";
let clonedFile = "";
let sheetLink = "";

let templates = JSON.parse(process.env.GOOGLE_TEMPLATE_IDS);
console.log("Template IDs: ", templates);

// const templates = JSON.parse(
//   tstr.replace(/(\w+):/g, '"$1":').replace(/'/g, '"')
// );

const capitalizeWords = (str) => {
    return str.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
};

const qa_type_select_values = Object.keys(templates).map(key => ({
    text: {
        type: "plain_text",
        text: capitalizeWords(key),  // Capitalize each word in the key
    },
    value: key,  // Use the original key as the value
}));

console.log(qa_type_select_values);

// Initialize the ExpressReceiver for handling Slack events
const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Initialize your Bolt App with the ExpressReceiver
const slackApp = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver: receiver,
});

console.log("Slack App initialized successfully ");
// console.log('Slack App users : ' , slackApp.client);
const googleCredentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

const auth = new google.auth.GoogleAuth({
    credentials: googleCredentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
});

//   // Google Drive Authentication
//   const auth = new google.auth.GoogleAuth({
//     keyFile: process.env.CONFIG,
//     scopes: ["https://www.googleapis.com/auth/drive"],
//   });

const driveClient = google.drive({ version: "v3", auth });

console.log("Google Drive authenticated successfully");

// Helper function to get the email of the Slack user
async function getUserEmail(client, userId) {
    try {
        const userInfo = await client.users.profile.get({ user: userId });
        if (userInfo.profile.email) {
            console.log(`User email found: ${userInfo.profile.email}`);
            return userInfo.profile.email;
        } else {
            console.error(`No email found for user: ${userId}`);
            return null; // No email found
        }
    } catch (error) {
        console.error(`Error fetching user profile for user: ${userId}`, error);
        return null; // Handle errors and return null
    }
}

// Function to invite the bot to the channel if it's not already in it
async function ensureBotInChannel(client, channelId) {
    try {
        // Join the channel
        await client.conversations.join({
            channel: channelId,
        });
        console.log(`Bot joined channel: ${channelId}`);
    } catch (error) {
        if (error.data && error.data.error === "already_in_channel") {
            console.log(`Bot is already in channel: ${channelId}`);
        } else {
            console.error("Error joining channel:", error);
        }
    }
}

// Function to get Slack user ID from email with error handling
async function getUserIdByEmail(client, email) {
    try {
        const user = await client.users.lookupByEmail({ email });
        if (user && user.user && user.user.id) {
            console.log(`Found Slack user ID for email ${email}: ${user.user.id}`);
            return user.user.id; // Return Slack user ID if found
        } else {
            console.error(`No valid Slack user found for email: ${email}`);
            return null;
        }
    } catch (error) {
        console.error(`Error fetching user by email: ${email}`, error);
        return null; // Return null if no user is found
    }
}

// Function to open the modal with updated fields
slackApp.command("/qa", async ({ ack, body, client }) => {
    await ack();
    console.log(
        `Received /qa command from user: ${body.user_id} in channel: ${body.channel_id}`
    );

    // Fetch user list dynamically inside the async function
    const users = await client.conversations.members({
        channel: body.channel_id,
    });

    const userList = await Promise.all(
        users.members.map(async (userId) => {
            const userInfo = await client.users.info({ user: userId });
            return {
                text: {
                    type: "plain_text",
                    text: userInfo.user.real_name || userInfo.user.name,
                },
                value: userId, // Store the Slack user ID
            };
        })
    );


    // Open the modal for user to submit QA form
    // Open the modal for user to submit QA form
    await client.views.open({
        trigger_id: body.trigger_id,
        view: {
            type: "modal",
            callback_id: "qa_form_submission",
            private_metadata: JSON.stringify({ channel_id: body.channel_id }),
            title: {
                type: "plain_text",
                text: "QA Submission",
            },
            blocks: [
                {
                    type: "input",
                    block_id: "assignee",
                    label: {
                        type: "plain_text",
                        text: "Assignee",
                    },
                    element: {
                        type: "static_select",
                        action_id: "assignee_select",
                        placeholder: {
                            type: "plain_text",
                            text: "Select a team member",
                        },
                        options: userList, // Use the dynamically fetched user list here
                    },
                },
                {
                    type: "input",
                    block_id: "project_name",
                    label: {
                        type: "plain_text",
                        text: "Project Name",
                    },
                    element: {
                        type: "plain_text_input",
                        action_id: "project_input",
                        placeholder: {
                            type: "plain_text",
                            text: "Enter the project name",
                        },
                    },
                },
                {
                    type: "input",
                    block_id: "qa_type",
                    label: {
                        type: "plain_text",
                        text: "Type",
                    },
                    element: {
                        type: "static_select",
                        action_id: "qa_type_select",
                        placeholder: {
                            type: "plain_text",
                            text: "Choose a QA task type",
                        },
                        options: qa_type_select_values,
                    },
                },
                {
                    type: "input",
                    block_id: "deadline",
                    label: {
                        type: "plain_text",
                        text: "Deadline Date",
                    },
                    element: {
                        type: "datepicker",
                        action_id: "deadline_select",
                        placeholder: {
                            type: "plain_text",
                            text: "Select a due date",
                        },
                        initial_date: new Date().toISOString().split("T")[0],
                    },
                },
                {
                    type: "input",
                    block_id: "time",
                    label: {
                        type: "plain_text",
                        text: "Deadline Time",
                    },
                    element: {
                        type: "timepicker", // Adding timepicker here
                        action_id: "timepicker",
                        placeholder: {
                            type: "plain_text",
                            text: "Select a time",
                        },
                    },
                },
                {
                    type: "input",
                    block_id: "notes",
                    optional: true,
                    label: {
                        type: "plain_text",
                        text: "Notes",
                    },
                    element: {
                        type: "plain_text_input",
                        action_id: "notes_input",
                        multiline: true,
                        placeholder: {
                            type: "plain_text",
                            text: "Provide additional task details",
                        },
                    },
                },
            ],
            submit: {
                type: "plain_text",
                text: "Submit",
            },
        },
    });


    console.log("Modal opened successfully");
});


slackApp.view("qa_form_submission", async ({ ack, body, view, client }) => {
    await ack();
    console.log("Acknowledged form submission.");

    try {
        assigneeUserId = view.state.values.assignee.assignee_select.selected_option.value;
        projectName = view.state.values.project_name.project_input.value;
        qaTask = view.state.values.qa_type.qa_type_select.selected_option.value;
        deadlineDate = view.state.values.deadline.deadline_select.selected_date;
        deadlineTime = view.state.values.time.timepicker.selected_time;
        deadline = `${deadlineDate} ${deadlineTime}`;
        notes = view.state.values.notes.notes_input.value || "No notes provided";
        requestorEmail = await getUserEmail(client, body.user.id);
        assigneeEmail = await getUserEmail(client, assigneeUserId);

        console.log("Assignee Email:", assigneeEmail);
        console.log("Requestor Email:", requestorEmail);
        console.log("QA Task:", qaTask);
        console.log("Deadline:", deadline);
        console.log("Notes:", notes);


        console.log("Private Metadata before parsing:", view.private_metadata);
        let parsedMetadata;
        try {
            parsedMetadata = JSON.parse(view.private_metadata || '{}');
        } catch (error) {
            console.error('Error parsing JSON:', error);
            return; // Exit or handle this case based on your needs
        }

        const channelId = parsedMetadata.channel_id || 'default-channel-id'; // Use fallback if needed
        console.log("Channel ID:", channelId);


        // Clone Google Sheet and update permissions
        const sheetTemplateId = getSheetTemplateId(qaTask);

        // Helper function to handle retries with exponential backoff
        async function withRetry(apiCall, retries = 5, backoff = 1000) {
            for (let i = 0; i < retries; i++) {
                try {
                    return await apiCall();  // Try the API call
                } catch (error) {
                    if (error.errors && error.errors[0].reason === 'userRateLimitExceeded') {
                        console.log(`Rate limit exceeded. Retrying in ${backoff} ms...`);
                        await new Promise(resolve => setTimeout(resolve, backoff));  // Wait for the backoff period
                        backoff *= 2;  // Exponentially increase the backoff time
                    } else {
                        throw error;  // Rethrow other errors
                    }
                }
            }
            throw new Error('Max retries reached');
        }
        try {
            clonedFile = await withRetry(() => driveClient.files.copy({
                fileId: sheetTemplateId,
                resource: {
                    name: `${deadline} - ${projectName} - ${properCase(qaTask)} QA`,
                    parents: [process.env.COPY_INTO_FOLDER_ID]
                },
                supportsAllDrives: true,
            }));

            await updateSheetPermissions(clonedFile.data.id, assigneeEmail, requestorEmail);
        } catch (error) {
            console.error('Error while copying file or setting permissions:', error);
        }
        sheetLink = `https://docs.google.com/spreadsheets/d/${clonedFile.data.id}`;
        const metadata = JSON.parse(view.private_metadata);
        // const channelId = metadata.channel_id;
        await ensureBotInChannel(client, channelId);

        // Send message with accept and reject buttons
        await client.chat.postMessage({
            channel: channelId,
            text: `👋 Hi <@${assigneeUserId}>, Here's the <${sheetLink}|${properCase(qaTask)} QA document> created for *${projectName}*, due on *${deadline}* by *${body.user.name}*.`,
            blocks: [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": `👋 Hi <@${assigneeUserId}>,\nHere's the <${sheetLink}|${properCase(qaTask)} QA document> created for *${projectName}*, due on *${deadline}* by *${body.user.name}*.\n*Notes*: ${notes}`
                    }
                },
                {
                    "type": "actions",
                    "elements": [
                        {
                            "type": "button",
                            "text": {
                                "type": "plain_text",
                                "text": "Accept"
                            },
                            "style": "primary",
                            "action_id": "accept_task"
                        },
                        {
                            "type": "button",
                            "text": {
                                "type": "plain_text",
                                "text": "Reject"
                            },
                            "style": "danger",
                            "action_id": "reject_task"
                        }
                    ]
                }
            ]
        });

        console.log(`Message with buttons posted in channel: ${channelId}`);
    } catch (error) {
        console.error("Error processing modal submission:", error);
    }
});


slackApp.view("reassign_task_modal_submission", async ({ ack, body, view, client }) => {
    await ack();
    console.log("Reassign modal submission acknowledged.");

    try {
        // Ensure that these block IDs and action IDs match the blocks in the modal
        assigneeUserId = view.state.values.new_assignee.assignee_select.selected_option.value;
        deadlineDate = view.state.values.new_deadline.deadline_select.selected_date;
        deadlineTime = view.state.values.time.timepicker.selected_time;
        notes = view.state.values.new_notes.notes_input.value || "No notes provided";
        deadline = `${deadlineDate} ${deadlineTime}`;


        // Retrieve the channel_id from private_metadata
        const privateMetadata = JSON.parse(view.private_metadata);
        const channelId = privateMetadata.channel_id;

        if (!channelId) {
            throw new Error("Channel ID is missing from private metadata.");
        }

        // Post the original message with updated values
        await client.chat.postMessage({
            channel: channelId,  // Use channel_id from private_metadata
            text: `👋 Hi <@${assigneeUserId}>, Here's the <${sheetLink}|${properCase(qaTask)} QA document> created for *${projectName}*, due on *${deadline}* by *${body.user.name}*.`,
            blocks: [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": `👋 Hi <@${assigneeUserId}>,\nHere's the <${sheetLink}|${properCase(qaTask)} QA document> created for *${projectName}*, due on *${deadline}* by *${body.user.name}*.\n*Notes*: ${notes}`
                    }
                },
                {
                    "type": "actions",
                    "elements": [
                        {
                            "type": "button",
                            "text": {
                                "type": "plain_text",
                                "text": "Accept"
                            },
                            "style": "primary",
                            "action_id": "accept_task"
                        },
                        {
                            "type": "button",
                            "text": {
                                "type": "plain_text",
                                "text": "Reject"
                            },
                            "style": "danger",
                            "action_id": "reject_task"
                        }
                    ]
                }
            ]
        });

        console.log("Reassignment successful and original message posted.");
    } catch (error) {
        console.error("Error processing reassign modal submission:", error);
    }
});


// Handle "Accept" button click
slackApp.action("accept_task", async ({ ack, body, client }) => {
    await ack();

    const requestorId = body.user.id;

    // Update the message to remove buttons but keep the original content
    await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts, // Reference the original message timestamp
        text: body.message.text, // Retain the original message text
        blocks: [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": body.message.blocks[0].text.text // Retain original message
                }
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": `<@${requestorId}> has accepted ✅ the task.`
                }
            }
        ]
    });
});


// Handle "Reject" button click
slackApp.action("reject_task", async ({ ack, body, client }) => {
    await ack();

    const requestorId = body.user.id;

    // Update the message to remove buttons but keep the original content
    await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts, // Reference the original message timestamp
        text: body.message.text, // Retain the original message text
        blocks: [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": body.message.blocks[0].text.text // Retain original message
                }
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": `<@${requestorId}> has rejected ❌ the task. Please reassign it.`
                }
            }
        ]
    });

    // Send an ephemeral message to the requestor with the "Re-Assign" button
    await client.chat.postEphemeral({
        channel: body.channel.id,
        user: requestorId, // Only the requestor can see this message
        text: `The QA task has been rejected by <@${requestorId}>. Would you like to reassign it to someone else?`,
        blocks: [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": `The QA task has been rejected by <@${requestorId}>. Would you like to reassign it to someone else?`
                }
            },
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "Re-Assign"
                        },
                        "style": "primary",
                        "action_id": "reassign_task"
                    }
                ]
            }
        ]
    });
});



// Handle "Re-Assign" button click
slackApp.action("reassign_task", async ({ ack, body, client }) => {
    await ack();

    // Fetch previous values (stored earlier)
    const previousNotes = notes;  // Retrieve the previous notes from the initial task submission
    const previousDeadline = deadline;  // Retrieve the previous deadline
    const previousAssigneeId = assigneeUserId;  // Previous assignee

    // Fetch user list dynamically for the modal
    const users = await client.conversations.members({
        channel: body.channel.id,
    });

    const userList = await Promise.all(
        users.members.map(async (userId) => {
            const userInfo = await client.users.info({ user: userId });
            return {
                text: {
                    type: "plain_text",
                    text: userInfo.user.real_name || userInfo.user.name,
                },
                value: userId, // Store the Slack user ID
            };
        })
    );

    // Find the previous assignee's information from the userList
    const previousAssignee = userList.find(user => user.value === previousAssigneeId);

    // Open the modal for re-assigning the task with pre-filled values
    await client.views.open({
        trigger_id: body.trigger_id,
        view: {
            type: "modal",
            callback_id: "reassign_task_modal_submission",
            private_metadata: JSON.stringify({ channel_id: body.channel.id }),  // Pass channel_id in metadata
            title: {
                type: "plain_text",
                text: "Re-Assign Task",
            },
            blocks: [
                {
                    type: "input",
                    block_id: "new_assignee",
                    label: {
                        type: "plain_text",
                        text: "New Assignee",
                    },
                    element: {
                        type: "static_select",
                        action_id: "assignee_select",
                        initial_option: previousAssignee ? {
                            text: {
                                type: "plain_text",
                                text: previousAssignee.text.text,  // Use the name of the previous assignee
                            },
                            value: previousAssignee.value,  // Use the Slack user ID of the previous assignee
                        } : null,  // Set the initial option only if there is a previous assignee
                        options: userList,  // Use dynamically fetched user list
                    },
                },
                {
                    type: "input",
                    block_id: "new_deadline",
                    label: {
                        type: "plain_text",
                        text: "Deadline",
                    },
                    element: {
                        type: "datepicker",
                        action_id: "deadline_select",
                        initial_date: previousDeadline.split(' ')[0],  // Pre-fill previous deadline date
                    },
                },
                {
                    type: "input",
                    block_id: "time",
                    label: {
                        type: "plain_text",
                        text: "Deadline Time",
                    },
                    element: {
                        type: "timepicker", // Correct usage of timepicker
                        action_id: "timepicker",
                        initial_time: previousDeadline.split(' ')[1],  // Pre-fill previous deadline time
                        placeholder: {
                            type: "plain_text",
                            text: "Select a time",
                        },
                    },
                },
                {
                    type: "input",
                    block_id: "new_notes",
                    label: {
                        type: "plain_text",
                        text: "Notes",
                    },
                    element: {
                        type: "plain_text_input",
                        action_id: "notes_input",
                        initial_value: previousNotes,  // Pre-fill previous notes
                    },
                },
            ],
            submit: {
                type: "plain_text",
                text: "Re-Assign",
            },
        },
    });


});


// Helper function to check if deadline date is in past 
// slackApp.action('deadline_select', async ({ ack, body, client }) => {
//   await ack();

//   const selectedDate = body.actions[0].selected_date;
//   const today = new Date().toISOString().split('T')[0];

//   if (selectedDate < today) {
//     await client.chat.postEphemeral({
//       channel: body.channel.id,
//       user: body.user.id,
//       text: "Please select a current or future date.",
//     });
//   } else {
//     // Proceed with handling the selected date
//     console.log('Task due date is in future')
//   }
// });


// Helper function to change text to proper case 
function properCase(str) {
    // Replace underscores with spaces
    str = str.replace(/_/g, ' ');

    // Convert to Proper Case (Title Case)
    str = str.split(' ').map(word =>
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    ).join(' ');

    return str;
}

// Helper function to get the Google Sheet template ID based on QA type
function getSheetTemplateId(qaType) {
    return templates[qaType];
}

// Helper function to update sheet permissions
async function updateSheetPermissions(fileId, assigneeEmail, requestorEmail) {
    try {
        // Log the emails being used for permission
        console.log(
            `Assigning permissions for assignee: ${assigneeEmail}, requestor: ${requestorEmail}`
        );

        // Assign permission to assignee
        if (assigneeEmail) {
            await driveClient.permissions.create({
                fileId,
                resource: {
                    type: "user",
                    role: "writer",
                    emailAddress: assigneeEmail,
                },
                supportsAllDrives: true
            });
            console.log(`Permissions granted to assignee: ${assigneeEmail}`);
        } else {
            console.error("Assignee email is invalid or undefined.");
        }

        // Assign permission to requestor
        if (requestorEmail) {
            await driveClient.permissions.create({
                fileId,
                resource: {
                    type: "user",
                    role: "writer",
                    emailAddress: requestorEmail,
                },
                supportsAllDrives: true
            });
            console.log(`Permissions granted to requestor: ${requestorEmail}`);
        } else {
            console.error("Requestor email is invalid or undefined.");
        }
    } catch (error) {
        console.error("Error assigning permissions:", error);
    }
}

// Default route to handle unhandled requests to '/'
receiver.app.post("/", (req, res) => {
    console.log("Received a POST request to root / ", req);
    res.send("Root path received POST request.");
});

// Middleware to log all requests
receiver.app.use((req, res, next) => {
    console.log(`Received request: ${req.method} ${req.url}`);
    next();
});

// Start the ExpressReceiver server (this will handle Slack events)
const PORT = process.env.PORT || 3000;
receiver.app.listen(PORT, () => {
    console.log(`⚡️ Express and Slack app are running on port ${PORT}`);
});
