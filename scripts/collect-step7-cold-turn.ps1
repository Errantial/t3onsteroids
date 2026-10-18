param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][int]$Index,
  [string]$CandidateProfile='C:\Users\emilg\t3onsteroids\.local-evidence\v1\20261017T100215Z-candidate-profile'
)
$ErrorActionPreference='Stop'
$turnDir=Join-Path $Root ("turn-{0:D2}" -f $Index)
$stateFile=Get-ChildItem -LiteralPath (Join-Path $turnDir 'state\sessions') -Filter '*.json' | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if(-not $stateFile){ throw 'state session missing' }
$state=Get-Content -Raw -LiteralPath $stateFile.FullName | ConvertFrom-Json
$metrics=Get-Content -Raw -LiteralPath (Join-Path $turnDir 'bridge-metrics.json') | ConvertFrom-Json
$recent=$metrics.recentTurns[-1]
$ep=Get-Content -Raw -LiteralPath (Join-Path $CandidateProfile 'control-api\endpoint.json') | ConvertFrom-Json
$token=(Get-Content -Raw -LiteralPath (Join-Path $CandidateProfile 'control-api\token')).Trim()
$headers=@{Authorization="Bearer $token"}
$events=(Invoke-RestMethod -Headers $headers -Uri ("http://127.0.0.1:{0}/v1/sessions/{1}/events?from=0" -f $ep.port,$state.sessionId)).events
$eventsPath=Join-Path $turnDir 'cos-events.json'
$events|ConvertTo-Json -Depth 20|Set-Content -LiteralPath $eventsPath -Encoding UTF8
$drain=@($events | Where-Object { $_.kind -eq 'turn_drained' -and $_.inputId -eq $state.sessionId })[-1]
if(-not $drain){ throw 'turn drain missing' }
$end=@($events | Where-Object { $_.kind -eq 'turn_end' -and $_.turnId -eq $drain.turnId })[-1]
if(-not $end){ throw 'matching turn_end missing' }
$final=@($events | Where-Object { $_.kind -eq 'assistant_message' -and $_.final -eq $true -and $_.seq -eq $drain.finalAssistantSeq })[0]
$helper=Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\step7-tool-eligibility.mjs'
if(-not (Test-Path -LiteralPath $helper)){ $helper=Join-Path $PSScriptRoot 'step7-tool-eligibility.mjs' }
$eligibilityJson=& node $helper $eventsPath $drain.inputId $drain.turnId
if($LASTEXITCODE -ne 0){ throw 'tool eligibility helper failed' }
$eligibility=$eligibilityJson | ConvertFrom-Json
Start-Sleep -Seconds 1
$logs="$env:USERPROFILE\.t3\userdata\logs"
$traceFiles=@(Get-ChildItem -LiteralPath $logs -Filter 'server.trace.ndjson*' | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 8)
$spanLines=@(& rg --no-filename 'session/prompt' @($traceFiles.FullName))
$span=@($spanLines | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} } | Sort-Object {[decimal]$_.endTimeUnixNano} | Select-Object -Last 1)[0]
$leases=@(Get-ChildItem -LiteralPath (Join-Path $turnDir 'state\leases') -Filter '*.json' -ErrorAction SilentlyContinue).Count
$row=[ordered]@{
 index=$Index
 sessionId=$state.sessionId
 generation=[int]$state.generation
 revision=[int]$state.revision
 cursor=[int]$state.cosEventCursor
 preSendMs=[int]$recent.preSendMs
 bridgeObservedDrainMs=[int]$recent.drainMs
 postDrainMs=[int]$recent.postDrainMs
 nativeDrainMs=[int]($drain.time-$end.time)
 turnId=$drain.turnId
 exactFinal=[bool]($final.final -eq $true)
 finalAssistantSeq=[int]$drain.finalAssistantSeq
 finalText=$final.message.text
 toolLikeCount=[int]$eligibility.toolLikeCount
 eligibleNoTool=[bool]$eligibility.eligibleNoTool
 eligibilityReason=$eligibility.reason
 toolLike=$eligibility.toolLike
 leaseCount=$leases
 t3DurationMs=[double]$span.durationMs
 t3Exit=$span.exit._tag
 t3SpanId=$span.spanId
}
$row|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $turnDir 'turn.json') -Encoding UTF8
($row|ConvertTo-Json -Compress -Depth 10)|Add-Content -LiteralPath (Join-Path $Root 'turns.jsonl') -Encoding UTF8
$row|ConvertTo-Json -Depth 10
