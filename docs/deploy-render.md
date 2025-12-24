# Deploying oss-agent Webhook Server to Render

This guide explains how to deploy the oss-agent webhook server to [Render](https://render.com) to receive GitHub webhook events for PR feedback and automatic branch deletion.

## Prerequisites

1. A [Render](https://render.com) account
2. A GitHub repository with this code pushed
3. A GitHub Personal Access Token with `repo` scope
4. (Optional) An Anthropic API key for auto-iterate functionality

## Quick Deploy with Blueprint

1. Push this repository to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com)
3. Click "New" → "Blueprint"
4. Connect your GitHub repository
5. Render will automatically detect `render.yaml` and create the service
6. Configure the required environment variables (see below)

## Manual Deploy

### 1. Create a new Web Service

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click "New" → "Web Service"
3. Connect your GitHub repository
4. Configure:
   - **Name**: `oss-agent-webhook`
   - **Runtime**: Docker
   - **Region**: Choose closest to your GitHub servers (Oregon recommended)
   - **Plan**: Free tier works for basic usage

### 2. Configure Environment Variables

Set these in the Render dashboard under "Environment":

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub PAT with `repo` scope for branch deletion |
| `WEBHOOK_SECRET` | Recommended | Secret for verifying GitHub webhook signatures |
| `ANTHROPIC_API_KEY` | For auto-iterate | API key to run iterate command on feedback |
| `ALLOWED_REPOS` | Optional | Comma-separated list of allowed repos (e.g., `owner/repo1,owner/repo2`) |
| `AUTO_ITERATE` | Optional | Set to `false` to disable auto-iterate (default: `true`) |
| `DELETE_BRANCH_ON_MERGE` | Optional | Set to `true` to delete branches on merge (default: `false`) |

### 3. Deploy

Click "Create Web Service". Render will:
1. Build the Docker image
2. Install dependencies and gh CLI
3. Start the webhook server on port 3000

## Configure GitHub Webhook

Once deployed, configure your GitHub repository webhook:

1. Go to your repository → Settings → Webhooks → Add webhook
2. Configure:
   - **Payload URL**: `https://your-service.onrender.com/webhook`
   - **Content type**: `application/json`
   - **Secret**: Same value as `WEBHOOK_SECRET` env var
   - **Events**: Select individual events:
     - `Pull request reviews`
     - `Pull request review comments`
     - `Pull requests` (if using delete-branch-on-merge)

3. Click "Add webhook"

## Verify Deployment

### Health Check

```bash
curl https://your-service.onrender.com/health
```

Expected response:
```json
{"status":"ok","timestamp":"2024-01-15T10:30:00.000Z"}
```

### Test Webhook

You can test by creating a review comment on any PR in your allowed repositories.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check endpoint |
| POST | `/` | Webhook endpoint |
| POST | `/webhook` | Webhook endpoint (alias) |

## Troubleshooting

### Service not starting

Check Render logs for errors. Common issues:
- Missing `GITHUB_TOKEN` - gh CLI won't authenticate
- Port misconfiguration - ensure service listens on port from `PORT` env var

### Webhooks not received

1. Check GitHub webhook delivery history (Settings → Webhooks → Recent Deliveries)
2. Verify the webhook URL is correct
3. Check if `ALLOWED_REPOS` is filtering out your repo

### Branch not deleted

1. Ensure `DELETE_BRANCH_ON_MERGE=true` is set
2. Check if `GITHUB_TOKEN` has permission to delete branches
3. Branch may be protected - check branch protection rules

### Auto-iterate not working

1. Ensure `ANTHROPIC_API_KEY` is set
2. Check if `AUTO_ITERATE` is not set to `false`
3. Review Render logs for errors during iterate execution

## Cost Considerations

- **Free tier**: 750 hours/month, service spins down after 15 min of inactivity
- **Starter ($7/month)**: Always-on, faster cold starts
- For production use, consider Starter plan to avoid cold start delays on webhooks

## Security Notes

1. Always set `WEBHOOK_SECRET` to verify webhook signatures
2. Use `ALLOWED_REPOS` to restrict which repositories can trigger actions
3. Keep `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` secure
4. Consider using Render's secret management for sensitive values
