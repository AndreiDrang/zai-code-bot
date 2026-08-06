# Z.ai Code Bot - Proof-of-Concept on Cloudflare Computer

## 🎯 Overview

This is a **Proof-of-Concept (POC)** implementation of the `/zai help` command running on Cloudflare Computer. The goal is to validate the architecture and measure performance before migrating the entire zai-code-bot from GitHub Actions.

## 🏗️ Architecture

```
GitHub Webhook → Cloudflare Worker → GitHub API → Response
```

- **Cloudflare Worker**: Handles GitHub webhook events
- **GitHub API**: Posts comments back to GitHub
- **Focus**: Only `/zai help` command for POC validation

## 📁 Project Structure

```
poc/
├── src/
│   ├── index.js              # Main Cloudflare Worker
│   ├── config/
│   │   └── constants.js      # Application constants
│   └── lib/
│       ├── github.js         # GitHub API client
│       ├── commands.js       # Command parsing
│       ├── logging.js        # Logging utilities
│       └── handlers/
│           └── help.js       # Help command handler
├── tests/
│   └── test.js              # Unit tests
├── wrangler.toml             # Cloudflare configuration
├── package.json
└── README.md
```

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- [Cloudflare Account](https://dash.cloudflare.com/sign-up)
- [GitHub Account](https://github.com/) with a repository to test

### 1. Install Dependencies

```bash
cd poc
npm install
```

### 2. Configure Cloudflare

```bash
# Login to Cloudflare
wrangler login

# Create KV namespaces (optional for POC)
wrangler kv:namespace create "STATE"
wrangler kv:namespace create "CACHE"

# Update wrangler.toml with namespace IDs
```

### 3. Configure Secrets

```bash
# Set GitHub Personal Access Token
wrangler secret put GITHUB_TOKEN
# Enter your token when prompted

# Set GitHub Webhook Secret
wrangler secret put GITHUB_WEBHOOK_SECRET
# Enter a random secret string
```

### 4. Deploy

```bash
npm run deploy
```

### 5. Configure GitHub Webhook

1. Go to your test repository → Settings → Webhooks
2. Click **Add webhook**
3. **Payload URL**: `https://zai-code-bot-poc.<your-account>.workers.dev`
4. **Content type**: `application/json`
5. **Secret**: Same as `GITHUB_WEBHOOK_SECRET`
6. **Events**: `Issue comments`
7. Check **Active**
8. Click **Add webhook**

### 6. Test

1. Create a new issue in your test repository
2. Comment: `/zai help`
3. The bot should reply with the help message

## 🧪 Testing

### Run Unit Tests

```bash
npm test
```

### Local Development

```bash
npm run dev
```

Then test with curl:

```bash
curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issue_comment" \
  -H "X-Hub-Signature-256: sha256=..." \
  -d '{
    "action": "created",
    "issue": { "number": 123 },
    "comment": { "body": "/zai help", "user": { "login": "testuser" } },
    "repository": { "owner": { "login": "testowner" }, "name": "test-repo" }
  }'
```

### View Logs

```bash
npm run tail
```

Or in Cloudflare Dashboard → Workers → Logs

## 📊 Performance Metrics

### Expected Improvements

| Metric | GitHub Actions | Cloudflare Computer | Improvement |
|--------|---------------|---------------------|-------------|
| Response Time | 30-60s | **5-10s** | ⬇️ 6-12x |
| Cost per Request | ~$0.02/min | **~$0.005** | ⬇️ 75% |
| Scalability | Limited | **Automatic** | ⬆️ ∞ |
| Reliability | 99.9% | **99.99%** | ⬆️ |

### How to Measure

1. **Response Time**: Check Cloudflare Analytics → Workers → Metrics
2. **Cost**: Check Cloudflare Dashboard → Billing
3. **Success Rate**: Monitor logs for errors

## 🎯 POC Goals

### Must Have ✅
- [ ] Cloudflare Worker deployed and running
- [ ] GitHub webhook configured and received
- [ ] `/zai help` command processed
- [ ] Response posted to GitHub
- [ ] Logs written to Cloudflare

### Should Have 🎉
- [ ] Authorization working
- [ ] Response time < 5 seconds
- [ ] Cost measured and documented
- [ ] Unit tests passing
- [ ] Documentation complete

### Nice to Have ⭐
- [ ] Monitoring configured
- [ ] Error alerts
- [ ] Performance metrics collected
- [ ] Results report

## 📝 Commands Supported

### In POC
- `/zai help` - Show help message ✅

### Not in POC (will respond with "not available")
- `/zai review` - Full code review
- `/zai ask` - Ask question about code
- `/zai explain` - Explain specific lines
- `/zai describe` - Generate PR description
- `/zai impact` - Analyze impact

## 🔧 Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GITHUB_TOKEN` | GitHub Personal Access Token | ✅ Yes |
| `GITHUB_WEBHOOK_SECRET` | Webhook signature secret | ✅ Yes |
| `NODE_ENV` | Environment (development/production) | ❌ No |
| `ZAI_MODEL` | Z.ai model to use | ❌ No |

### GitHub Token Scope

Required scopes for `GITHUB_TOKEN`:
- `repo` - Full control of private repositories
- `read:org` - Read org and team membership

## 🚨 Troubleshooting

### Webhook Not Received

1. **Check signature**: Ensure `X-Hub-Signature-256` is correct
2. **Check secret**: Verify `GITHUB_WEBHOOK_SECRET` matches
3. **Check webhook**: Ensure webhook is active in GitHub
4. **Check URL**: Verify webhook URL is correct

**Test webhook signature:**
```javascript
const crypto = require('crypto');
const secret = 'your-secret';
const payload = '{"action":"created",...}';
const hmac = crypto.createHmac('sha256', secret);
hmac.update(payload);
console.log(`sha256=${hmac.digest('hex')}`);
```

### Bot Not Responding

1. **Check logs**: `npm run tail`
2. **Check token**: Ensure `GITHUB_TOKEN` is valid
3. **Check permissions**: User must have write access to repository
4. **Check rate limits**: GitHub API has rate limits

### Authorization Error

1. **Check token scope**: Must include `repo`
2. **Check user access**: User must have write access to repository
3. **Check token expiration**: Personal Access Tokens can expire

## 📚 Documentation

- [Full POC Plan](../plans/POC_HELP_COMMAND.md) - Detailed implementation plan
- [Quick Start Guide](../plans/POC_QUICK_START.md) - Minimal setup instructions
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [GitHub Webhooks Docs](https://docs.github.com/en/webhooks)

## 🎉 Next Steps

After successful POC:

1. **Measure performance** and compare with GitHub Actions
2. **Document results** in a report
3. **Decide on full migration**
4. **Implement remaining commands**:
   - `/zai review` (auto-review PR)
   - `/zai ask` (Q&A)
   - `/zai explain` (code explanation)
   - `/zai describe` (PR description)
   - `/zai impact` (impact analysis)
5. **Migrate scheduled tasks**
6. **Migrate CI/CD pipeline**

## 💬 Support

For issues or questions:
- Check [Cloudflare Workers Discord](https://discord.gg/cloudflare)
- Check [Cloudflare Community](https://community.cloudflare.com/)
- Check GitHub Issues in this repository

## 📄 License

This POC is part of the zai-code-bot project and inherits its license.

---

**Status**: Ready for deployment
**Version**: 0.1.0
**Last Updated**: 2024
