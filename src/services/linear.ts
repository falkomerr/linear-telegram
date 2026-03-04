import { ComposedTask, IssueCreatedResult, LinearIssue } from "../models.js";
import { logger } from "../logger.js";

const mutation = `
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
      title
      url
    }
    error {
      message
    }
  }
}
`;

const defaultUrl = "https://api.linear.app/graphql";

interface GraphqlResponse {
  data?: {
    issueCreate?: {
      success: boolean;
      issue?: LinearIssue;
      error?: { message: string };
    };
  };
  errors?: Array<{ message: string }>;
}

export const createLinearIssue = async (
  payload: ComposedTask,
  projectId: string,
  teamId: string,
  apiToken: string,
  linearApiUrl = defaultUrl
): Promise<IssueCreatedResult> => {
  const variables = {
    input: {
      teamId,
      projectId,
      title: payload.title,
      description: payload.description,
      priority: payload.priority,
      stateId: payload.state,
      estimate: payload.estimate,
      assigneeId: payload.assignee,
      dueDate: payload.dueDate
    }
  };

  const response = await fetch(linearApiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query: mutation, variables })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Linear API error ${response.status}: ${details}`);
  }

  const result = (await response.json()) as GraphqlResponse;

  const apiError = result.errors?.[0]?.message;
  if (apiError) {
    throw new Error(`Linear GraphQL error: ${apiError}`);
  }

  const payloadOut = result.data?.issueCreate;
  if (!payloadOut || !payloadOut.success || !payloadOut.issue) {
    const err = payloadOut?.error?.message || "Unknown Linear API error";
    logger.warn("Linear issueCreate failed", { err, payload: payloadOut });
    throw new Error(err);
  }

  return { issue: payloadOut.issue };
};
