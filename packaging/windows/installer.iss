; The Windows installer: the packaged build (scripts/package.js), installed
; for the current user — no administrator needed — in
; %LOCALAPPDATA%\Programs\ArtNet Lightshow, with a Start menu entry.
;
; It leaves out the `portable` file, so the installed app keeps its data
; (settings, show, analysis cache and environment, logs) in
; %LOCALAPPDATA%\ArtNet Lightshow (scripts/sea-main.cjs), where an update or
; an uninstall leaves it be.
;
; Built by CI on Windows (.github/workflows/package.yml):
;
;   ISCC.exe /DAppVersion=1.0.0 /DSourceDir=<the package folder> /DOutputDir=dist packaging\windows\installer.iss

#define AppName "ArtNet Lightshow"
#define AppExe "ArtNet Lightshow.exe"
#ifndef AppVersion
  #error Pass /DAppVersion=<version>
#endif
#ifndef SourceDir
  #error Pass /DSourceDir=<the package folder scripts/package.js made>
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif

[Setup]
; Never change: it is how Windows knows an update from another program.
AppId={{814CF9FC-1830-4C6D-90C1-35FB9F07305F}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisherURL=https://github.com/LightD31/artnet-lightshow
AppSupportURL=https://github.com/LightD31/artnet-lightshow/issues
DefaultDirName={autopf}\{#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
LicenseFile={#SourceDir}\app\LICENSE
SetupIconFile={#SourceDir}\app\public\favicon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
OutputDir={#OutputDir}
OutputBaseFilename=ArtNet-Lightshow-{#AppVersion}-win32-x64-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; A running copy holds its files: ask to close it (it blacks the rig out as it goes).
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; An update replaces the app outright, so nothing of the old version's
; node_modules lingers. The data is elsewhere and untouched.
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\tools"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "\portable,\data"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
