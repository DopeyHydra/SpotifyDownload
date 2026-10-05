; Inno-Setup-Skript für den Spotify Downloader
; Wird von build/build.mjs aufgerufen (AppVersion wird per /D übergeben).

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define AppName "Spotify Downloader"
#define AppExe "SpotifyDownloader.exe"

[Setup]
AppId={{6B0E3C2A-8E1F-4C7B-9D3A-52F1A7C9E4B1}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
; Installation pro Benutzer: keine Adminrechte nötig, yt-dlp kann sich selbst aktualisieren
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\{#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
OutputDir=..\dist
OutputBaseFilename=SpotifyDownloader-Setup-{#AppVersion}
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=force
RestartApplications=no

[Languages]
Name: "german"; MessagesFile: "compiler:Languages\German.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\dist\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autoprograms}\{#AppName} deinstallieren"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
; Selbst-Update aus dem Programm heraus (still): neue Version direkt wieder starten
Filename: "{app}\{#AppExe}"; Parameters: "--updated"; Flags: nowait; Check: IsSelfUpdate

[UninstallRun]
; Laufendes Programm (inkl. yt-dlp/ffmpeg) vor dem Entfernen beenden
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM {#AppExe}"; Flags: runhidden; RunOnceId: "KillApp"

[Code]
function IsSelfUpdate: Boolean;
begin
  Result := ExpandConstant('{param:UPDATE|0}') = '1';
end;

[UninstallDelete]
; Einstellungen, Log und aktualisierte Werkzeuge entfernen – heruntergeladene Musik bleibt erhalten
Type: filesandordirs; Name: "{app}\bin"
Type: files; Name: "{app}\config.json"
Type: files; Name: "{app}\app.log"
Type: dirifempty; Name: "{app}"
