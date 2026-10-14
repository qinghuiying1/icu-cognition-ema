param(
    [string]$SourceDocx = '',
    [string]$PythonExe = 'C:\Users\10942\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe',
    [ValidateRange(-10, 10)][int]$SpeechRate = 0,
    [switch]$Overwrite
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($SourceDocx)) {
    $SourceDocx = Join-Path (Split-Path -Parent $projectRoot) '现用Stroop卡片\现用Stroop卡片.docx'
}
$manifestPath = Join-Path $projectRoot 'public\material-manifest.json'
if ((Test-Path -LiteralPath $manifestPath) -and -not $Overwrite) {
    throw 'Materials already exist. Use -Overwrite only before formal collection and after reviewing the material version.'
}
if (-not (Test-Path -LiteralPath $PythonExe)) { throw 'Bundled Python executable not found. Pass -PythonExe with the configured runtime path.' }
if (-not (Test-Path -LiteralPath $SourceDocx)) { throw 'Source Stroop DOCX not found.' }
Add-Type -AssemblyName System.Speech
$rawDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('icu_fixed_speech_' + [guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($rawDirectory) | Out-Null
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $speech.SelectVoice('Microsoft Huihui Desktop')
    $speech.Rate = $SpeechRate
    $speech.Volume = 100
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $content = [ordered]@{
        'lamei' = '腊梅'; 'haitang' = '海棠'; 'yulan' = '玉兰'; 'baihe' = '百合'
        'lvshi' = '律师'; 'siji' = '司机'; 'shibing' = '士兵'; 'mugong' = '木工'
        'changku' = '长裤'; 'shoutao' = '手套'; 'toujin' = '头巾'; 'dayi' = '大衣'
        'delay-cue' = '请告诉我您刚才记住的三个词。'; 'stop' = '停。'; 'start' = '开始'
    }
    foreach ($entry in $content.GetEnumerator()) {
        $rawPath = Join-Path $rawDirectory ($entry.Key + '.wav')
        $speech.SetOutputToWaveFile($rawPath, $format)
        $speech.Speak($entry.Value)
        $speech.SetOutputToNull()
    }
} finally {
    $speech.Dispose()
}
& $PythonExe (Join-Path $PSScriptRoot 'prepare-materials.py') finalize --root $projectRoot --source $SourceDocx --raw-dir $rawDirectory --speech-rate $SpeechRate
if ($LASTEXITCODE -ne 0) { throw 'Material finalization failed.' }
& $PythonExe (Join-Path $PSScriptRoot 'prepare-materials.py') verify --root $projectRoot --source $SourceDocx
if ($LASTEXITCODE -ne 0) { throw 'Material verification failed.' }
Write-Output ('Generated raw WAV files remain in temporary path for traceability: ' + $rawDirectory)
Write-Output 'Technical checks completed. Researcher and actual tablet listening remain required before formal collection.'
