  
  console.log(process.env.CONFIG);
  
  const { App, ExpressReceiver } = require("@slack/bolt");
  const { google } = require("googleapis");
  const express = require("express");
  const bodyParser = require("body-parser");
  
  const templates = JSON.parse(process.env.GOOGLE_TEMPLATE_IDS);
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
  
    // Get list of users in the channel
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
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "qa_form_submission",
        private_metadata: JSON.stringify({ channel_id: body.channel_id }), // Pass the channel_id here
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
                text: "Assign to a user",
              },
              options: userList, // Dynamic user list
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
                text: "Add project name here",
              },
            },
          },
          {
            type: "input",
            block_id: "qa_type",
            label: {
              type: "plain_text",
              text: "QA Task",
            },
            element: {
              type: "static_select",
              action_id: "qa_type_select",
              options: qa_type_select_values
            },
          },
          {
            type: "input",
            block_id: "deadline",
            label: {
              type: "plain_text",
              text: "Deadline",
            },
            element: {
              type: "datepicker",
              action_id: "deadline_select",
              initial_date: "2024-10-02",
            },
          },
          {
            type: "input",
            block_id: "notes",
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
                text: "Add task details here",
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
      // Extract values from modal submission
      const assigneeUserId =
        view.state.values.assignee.assignee_select.selected_option.value;
      const projectName = view.state.values.project_name.project_input.value;
      const qaTask =
        view.state.values.qa_type.qa_type_select.selected_option.value;
      const deadline = view.state.values.deadline.deadline_select.selected_date;
      const notes =
        view.state.values.notes.notes_input.value || "No notes provided";
      const requestorEmail = await getUserEmail(client, body.user.id);
      const assigneeEmail = await getUserEmail(client, assigneeUserId);
  
      console.log("Assignee Email:", assigneeEmail);
      console.log("Requestor Email:", requestorEmail);
      console.log("QA Task:", qaTask);
      console.log("Deadline:", deadline);
      console.log("Notes:", notes);
  
      // Get the Google Sheet template ID based on QA type
      const sheetTemplateId = getSheetTemplateId(qaTask);
      console.log(`Google Sheet template ID for ${qaTask}: ${sheetTemplateId}`);
  
      const clonedFile = await driveClient.files.copy({
        fileId: sheetTemplateId,
        resource: {
          name: `${projectName} - ${deadline} - ${qaTask} QA Sheet`,
        },
      });
      console.log(`Google Sheet cloned successfully: ${clonedFile.data.id}. Sheet Name: ${projectName} - ${deadline} - ${qaTask} QA Sheet.csv`);
  
      // Update permissions for assignee and requestor
      await updateSheetPermissions(
        clonedFile.data.id,
        assigneeEmail,
        requestorEmail
      );
  
      console.log("Permissions updated for assignee and requestor");
  
      const sheetLink = `https://docs.google.com/spreadsheets/d/${clonedFile.data.id}`;
  
      // Retrieve the channel_id from the private_metadata
      const metadata = JSON.parse(view.private_metadata);
      const channelId = metadata.channel_id;
  
      // Ensure the bot is in the channel before posting the message
      await ensureBotInChannel(client, channelId);
  
      // Send message to channel in the specified format
      await client.chat.postMessage({
        channel: channelId,
        text: `Hi <@${assigneeUserId}>, Here's the QA document created for *${projectName}* - *${qaTask}*, due on *${deadline}*. _Notes: ${notes}_`,  
        blocks: [
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": `:wave: Hi <@${assigneeUserId}>,\n\nHere's the QA document created for *${projectName}* - *${qaTask}*, due on *${deadline}*.`
            }
          },
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": `:page_with_curl: *Google Sheet*: <${sheetLink}|Click here>`
            }
          },
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": `*Notes*:\n${notes}`
            }
          },
          {
            "type": "divider"
          }
        ]
      });
      
      
      // await client.chat.postMessage({
      //   channel: channelId,
      //   text: `Hi <@${assigneeUserId}> :wave:,\nHere's the QA document created for *${projectName}* - *${qaTask}*, due on *${deadline}*.\n${sheetLink}\n\n_Notes: ${notes}_`,
      // });
  
      console.log(`Message posted in channel: ${channelId}`);
    } catch (error) {
      console.error("Error processing modal submission:", error);
    }
  });
  
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
            emailAddress: assigneeEmail, // Ensure this is a valid email
          },
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
            emailAddress: requestorEmail, // Ensure this is a valid email
          },
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
  