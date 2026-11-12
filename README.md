# Go Voltic site scan

Scores a public page and posts the result to the job summary. Runs the same free scan as [go-voltic.com/scan](https://go-voltic.com/scan), called as an MCP tool.

```yaml
- uses: go-voltic/site-scan-action@v1
  with:
    url: https://example.com
    fail-under: 70
```

## What this sends

The `url` input, over `POST https://go-voltic.com/mcp`, and nothing else. No secret is read and none is needed: the endpoint takes no key, no token and no sign-in. Nothing from the repository, the workflow or the runner is sent.

## Inputs

| Name | Required | Description |
| --- | --- | --- |
| `url` | yes | The public page to scan, for example `https://example.com`. |
| `fail-under` | no | Fail the job if the score is below this number, 0 to 100. Leave empty to never fail on the score. |

## Outputs

| Name | Description |
| --- | --- |
| `score` | The scan score, 0 to 100. Empty when the scan did not complete. |
| `report-url` | A link to view and re-run this scan on go-voltic.com. |

## What makes the step fail

A score below `fail-under`, when that input is set. Separately, a rate limit or a network failure fails the step with the reason in the log; in that case neither output is set and no score is printed, because there is not one to report.

## Limits

The endpoint shares its rate limit with the free scan on the website: ten calls every five minutes per caller address. A category with nothing measurable on the target page is reported as not measured, never as zero.
