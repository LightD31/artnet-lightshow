<#
.SYNOPSIS
  Streams the Windows "now playing" media session as newline-delimited JSON.

.DESCRIPTION
  Reads the System Media Transport Controls (SMTC) — the same OS media session
  that powers the volume-overlay now-playing widget — and prints one compact
  JSON object per poll to stdout. The Node side (src/smtc-source.js) spawns this
  and feeds the snapshots into the now-playing source, so any player that reports
  to SMTC (e.g. a track playing in a Chromium browser) drives the auto-show — no
  per-service developer credentials required.

  MUST run under Windows PowerShell 5.1 (powershell.exe): PowerShell 7 (pwsh)
  dropped the built-in WinRT projection this relies on. Node invokes it with the
  full path to powershell.exe, never pwsh.

.PARAMETER IntervalMs
  Poll interval in milliseconds. Default 500 — snappy enough for track changes,
  cheap enough to run forever on localhost.

.OUTPUTS
  One JSON line per poll, e.g.
    {"ok":true,"title":"...","artist":"...","album":"...","appId":"...",
     "isPlaying":true,"positionMs":42100,"durationMs":215000}
  When nothing is playing: {"ok":true,"title":null}
  On error:                {"ok":false,"error":"..."}
#>
[CmdletBinding()]
param([int]$IntervalMs = 500)

$ErrorActionPreference = 'Stop'

# UTF-8 stdout so accented track titles survive the pipe to Node.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime

# WinRT async methods return IAsyncOperation<T>; bridge them to awaitable Tasks.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $asTask.Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}

# Project the SMTC WinRT types into PowerShell.
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus, Windows.Media.Control, ContentType = WindowsRuntime]

$mgrType    = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType  = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$PlayingEnum = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing

$manager = Await ($mgrType::RequestAsync()) $mgrType

function Write-Json($obj) {
    [Console]::WriteLine(($obj | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}

while ($true) {
    try {
        $session = $manager.GetCurrentSession()
        if (-not $session) {
            Write-Json @{ ok = $true; title = $null }
        }
        else {
            $props    = Await ($session.TryGetMediaPropertiesAsync()) $propsType
            $playback = $session.GetPlaybackInfo()
            $timeline = $session.GetTimelineProperties()

            $isPlaying = ($playback.PlaybackStatus -eq $PlayingEnum)

            # Position/duration are bounded by Start/End; most apps use Start=0.
            $startMs = [double]$timeline.StartTime.TotalMilliseconds
            $endMs   = [double]$timeline.EndTime.TotalMilliseconds
            $posMs   = [double]$timeline.Position.TotalMilliseconds - $startMs
            $durMs   = $endMs - $startMs

            # Sanity bounds: some apps report uninitialised/garbage timelines
            # (huge or negative values). Treat anything implausible as "unknown".
            $MAX_MS = 24 * 60 * 60 * 1000   # 24h
            if ($durMs -lt 0 -or $durMs -gt $MAX_MS) { $durMs = 0 }
            if ($posMs -lt 0 -or $posMs -gt $MAX_MS) { $posMs = 0 }

            # SMTC only refreshes Position on play/pause/seek. Interpolate from
            # LastUpdatedTime while playing so the lightshow stays beat-aligned —
            # but only if LastUpdatedTime is fresh (a stale one means the app
            # doesn't keep the timeline current, so interpolation would drift).
            $lastUpdated = $timeline.LastUpdatedTime
            if ($isPlaying -and $lastUpdated.Year -gt 2000) {
                $elapsed = ([DateTimeOffset]::Now - $lastUpdated).TotalMilliseconds
                if ($elapsed -gt 0 -and $elapsed -lt 600000) { $posMs += $elapsed }
            }
            if ($durMs -gt 0 -and $posMs -gt $durMs) { $posMs = $durMs }

            Write-Json ([ordered]@{
                ok         = $true
                title      = $props.Title
                artist     = $props.Artist
                album      = $props.AlbumTitle
                appId      = $session.SourceAppUserModelId
                isPlaying  = [bool]$isPlaying
                positionMs = [long][math]::Round($posMs)
                durationMs = [long][math]::Round($durMs)
            })
        }
    }
    catch {
        Write-Json @{ ok = $false; error = $_.Exception.Message }
    }
    Start-Sleep -Milliseconds $IntervalMs
}
