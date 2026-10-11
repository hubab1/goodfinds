#ifndef PluginVersion
  #error PluginVersion is required
#endif
#ifndef Payload
  #error Payload is required
#endif
[Setup]
AppId=com.thirdtech.goodfinds
AppName=Goodfinds
AppVersion={#PluginVersion}
AppPublisher=Third Tech
DefaultDirName={localappdata}\Goodfinds
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputDir=..\..\dist
OutputBaseFilename=Goodfinds-{#PluginVersion}-windows-x64
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Goodfinds plugin
CloseApplications=yes

[Files]
Source: "{#Payload}\*"; DestDir: "{app}\plugin"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\dist\installers\windows\GoodfindsRegister.exe"; DestDir: "{app}"; Flags: ignoreversion

[Messages]
FinishedHeadingLabel=Goodfinds is ready
FinishedLabel=Restart ChatGPT, open Plugins, choose your personal source, and install Goodfinds. Then tell your agent what you're looking for.

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
    if not Exec(ExpandConstant('{app}\GoodfindsRegister.exe'), 'install "' + ExpandConstant('{app}\plugin') + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
      RaiseException('Goodfinds could not update your plugin catalog. Your existing catalog has been kept. Check it and run setup again.');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
    Exec(ExpandConstant('{app}\GoodfindsRegister.exe'), 'remove "' + ExpandConstant('{app}\plugin') + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;
