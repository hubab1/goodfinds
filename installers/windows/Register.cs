using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class RegisterGoodfinds {
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static int Main(string[] args) {
        try {
            if (args.Length != 2 || (args[0] != "install" && args[0] != "remove")) throw new Exception("Expected install or remove and a plugin directory.");
            string home = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
            string payload = Path.GetFullPath(args[1]);
            if (!payload.StartsWith(home + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("Install Goodfinds for the current user.");
            string relative = "./" + payload.Substring(home.Length + 1).Replace('\\', '/');
            string catalog = Path.Combine(home, ".agents", "plugins", "marketplace.json");
            bool remove = args[0] == "remove";
            if (remove && !File.Exists(catalog)) return 0;
            if (!remove) {
                var manifest = Json.DeserializeObject(File.ReadAllText(Path.Combine(payload, ".codex-plugin", "plugin.json"))) as Dictionary<string, object>;
                if (manifest == null || !manifest.ContainsKey("name") || (string)manifest["name"] != "goodfinds-marketplace" || !File.Exists(Path.Combine(payload, "server", "goodfinds.exe"))) throw new Exception("The included Goodfinds plugin is incomplete.");
            }
            using (var gate = new Mutex(false, @"Local\GoodfindsPluginInstaller")) {
                if (!gate.WaitOne(TimeSpan.FromSeconds(10))) throw new Exception("Another Goodfinds installer is running.");
                try {
                    string original = File.Exists(catalog) ? File.ReadAllText(catalog) : null;
                    var marketplace = original == null
                        ? new Dictionary<string, object> { {"name", "personal"}, {"interface", new Dictionary<string, object> {{"displayName", "My plugins"}}}, {"plugins", new object[0]} }
                        : Json.DeserializeObject(original) as Dictionary<string, object>;
                    if (marketplace == null || !marketplace.ContainsKey("name") || !(marketplace["name"] is string) || !marketplace.ContainsKey("plugins") || !(marketplace["plugins"] is object[])) throw new Exception("Your existing plugin catalog is not valid. It has been left unchanged.");
                    var entries = ((object[])marketplace["plugins"]).ToList();
                    entries.RemoveAll(item => {
                        var entry = item as Dictionary<string, object>;
                        if (entry == null || !entry.ContainsKey("name") || (string)entry["name"] != "goodfinds-marketplace") return false;
                        if (!remove) return true;
                        var source = entry.ContainsKey("source") ? entry["source"] as Dictionary<string, object> : null;
                        return source != null && source.ContainsKey("path") && String.Equals(source["path"] as string, relative, StringComparison.OrdinalIgnoreCase);
                    });
                    if (!remove) entries.Add(new Dictionary<string, object> {
                        {"name", "goodfinds-marketplace"},
                        {"source", new Dictionary<string, object> {{"source", "local"}, {"path", relative}}},
                        {"policy", new Dictionary<string, object> {{"installation", "AVAILABLE"}, {"authentication", "ON_INSTALL"}}},
                        {"category", "Productivity"}
                    });
                    marketplace["plugins"] = entries.ToArray();
                    Directory.CreateDirectory(Path.GetDirectoryName(catalog));
                    string temporary = catalog + "." + Guid.NewGuid().ToString("N") + ".tmp";
                    try {
                        File.WriteAllText(temporary, Json.Serialize(marketplace), new UTF8Encoding(false));
                        string current = File.Exists(catalog) ? File.ReadAllText(catalog) : null;
                        if (current != original) throw new Exception("Your plugin catalog changed during setup. Please run the installer again.");
                        if (original == null) File.Move(temporary, catalog);
                        else File.Replace(temporary, catalog, null);
                    } finally { if (File.Exists(temporary)) File.Delete(temporary); }
                } finally { gate.ReleaseMutex(); }
            }
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
