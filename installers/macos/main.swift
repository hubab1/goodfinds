import AppKit
import CryptoKit
import Foundation

enum InstallError: LocalizedError {
    case invalid(String)
    var errorDescription: String? {
        switch self { case .invalid(let message): return message }
    }
}

enum GoodfindsInstall {
    static let pluginName = "goodfinds-marketplace"

    static func pluginURL(home: URL) -> URL {
        var link = URLComponents()
        link.scheme = "codex"
        link.host = "plugins"
        link.path = "/\(pluginName)"
        link.queryItems = [URLQueryItem(name: "marketplacePath", value: home.appendingPathComponent(".agents/plugins/marketplace.json").path)]
        // Query decoders often interpret a literal plus as a space.
        link.percentEncodedQuery = link.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return link.url!
    }

    static func object(_ url: URL) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else {
            throw InstallError.invalid("The plugin catalog is not a JSON object. No settings were changed.")
        }
        return value
    }

    static func fingerprint(_ directory: URL) throws -> String {
        let root = directory.resolvingSymlinksInPath().standardizedFileURL
        let fm = FileManager.default
        guard let items = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey]) else {
            throw InstallError.invalid("The installer could not read its included files.")
        }
        var files: [URL] = []
        for case let file as URL in items {
            let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            if values.isSymbolicLink == true { throw InstallError.invalid("The plugin contains an unexpected symbolic link.") }
            if values.isRegularFile == true { files.append(file.resolvingSymlinksInPath().standardizedFileURL) }
        }
        var hash = SHA256()
        for file in files.sorted(by: { $0.path < $1.path }) {
            let relative = String(file.path.dropFirst(root.path.count))
            hash.update(data: Data(relative.utf8))
            hash.update(data: Data([0]))
            hash.update(data: try Data(contentsOf: file))
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func install(payload: URL, home: URL) throws -> URL {
        let fm = FileManager.default
        let manifest = try object(payload.appendingPathComponent(".codex-plugin/plugin.json"))
        guard manifest["name"] as? String == pluginName,
              let version = manifest["version"] as? String,
              version.range(of: #"^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$"#, options: .regularExpression) != nil,
              fm.isExecutableFile(atPath: payload.appendingPathComponent("server/goodfinds").path) else {
            throw InstallError.invalid("This installer does not contain a valid Goodfinds plugin.")
        }
        let build = try object(payload.appendingPathComponent("server/build.json"))
        #if arch(arm64)
        let expectedTarget = "aarch64-apple-darwin"
        #else
        let expectedTarget = "x86_64-apple-darwin"
        #endif
        let universal = build["target"] as? String == "universal-apple-darwin"
            && Set(build["targets"] as? [String] ?? []) == Set(["aarch64-apple-darwin", "x86_64-apple-darwin"])
        guard build["target"] as? String == expectedTarget || universal else {
            throw InstallError.invalid("Download the Goodfinds installer that matches your Mac.")
        }

        let catalog = home.appendingPathComponent(".agents/plugins/marketplace.json")
        let original = fm.fileExists(atPath: catalog.path) ? try Data(contentsOf: catalog) : nil
        var marketplace: [String: Any]
        if let original {
            guard let parsed = try JSONSerialization.jsonObject(with: original) as? [String: Any],
                  parsed["name"] is String, parsed["plugins"] is [[String: Any]] else {
                throw InstallError.invalid("Your plugin catalog needs attention. It has been left unchanged.")
            }
            marketplace = parsed
        } else {
            marketplace = ["name": "personal", "interface": ["displayName": "My plugins"], "plugins": [[String: Any]]()]
        }
        let digest = try fingerprint(payload)
        let relative = ".local/share/goodfinds-plugins/\(version)/\(digest.prefix(16))"
        let destination = home.appendingPathComponent(relative)
        var created = false
        if fm.fileExists(atPath: destination.path) {
            guard try fingerprint(destination) == digest else {
                throw InstallError.invalid("An installed copy has changed. No files were replaced.")
            }
        } else {
            try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            let staging = destination.deletingLastPathComponent().appendingPathComponent(".install-\(UUID().uuidString)")
            defer { try? fm.removeItem(at: staging) }
            try fm.copyItem(at: payload, to: staging)
            try fm.moveItem(at: staging, to: destination)
            created = true
        }
        do {
            var plugins = marketplace["plugins"] as? [[String: Any]] ?? []
            let entry: [String: Any] = [
                "name": pluginName,
                "source": ["source": "local", "path": "./\(relative)"],
                "policy": ["installation": "AVAILABLE", "authentication": "ON_INSTALL"],
                "category": "Productivity",
            ]
            plugins.removeAll { $0["name"] as? String == pluginName }
            plugins.append(entry)
            marketplace["plugins"] = plugins
            let data = try JSONSerialization.data(withJSONObject: marketplace, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            try fm.createDirectory(at: catalog.deletingLastPathComponent(), withIntermediateDirectories: true)
            // Detect a catalog edit made while files were being copied.
            let current = fm.fileExists(atPath: catalog.path) ? try Data(contentsOf: catalog) : nil
            guard current == original else {
                throw InstallError.invalid("Your plugin catalog changed during installation. Please try again.")
            }
            try data.write(to: catalog, options: .atomic)
        } catch {
            if created { try? fm.removeItem(at: destination) }
            throw error
        }
        return destination
    }
}

@MainActor
final class InstallerApp: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let title = NSTextField(wrappingLabelWithString: "Add Goodfinds\nto ChatGPT.")
    let message = NSTextField(wrappingLabelWithString: "We’ll prepare Goodfinds on your Mac, then open\nits plugin page so you can finish in ChatGPT.")
    let progress = NSTextField(labelWithString: "1  Set up on your Mac     →     2  Enable in ChatGPT")
    let action = NSButton(title: "Continue in ChatGPT", target: nil, action: nil)
    let help = NSButton(title: "Need help?", target: nil, action: nil)
    var finished = false
    // A preview never writes files or opens the host, so it is safe for UI review.
    let previewOnly = CommandLine.arguments.contains("--preview") || Bundle.main.object(forInfoDictionaryKey: "GoodfindsPreview") as? Bool == true

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 540, height: 520), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = previewOnly ? "Goodfinds Setup — Preview" : "Goodfinds Setup"
        window.backgroundColor = .white
        window.appearance = NSAppearance(named: .aqua)
        window.center()
        let content = window.contentView!
        let logo = NSImageView()
        logo.image = NSImage(contentsOf: Bundle.main.resourceURL!.appendingPathComponent("logo.png"))
        logo.wantsLayer = true
        logo.layer?.backgroundColor = NSColor.black.cgColor
        logo.layer?.cornerRadius = 14
        logo.layer?.masksToBounds = true
        logo.widthAnchor.constraint(equalToConstant: 64).isActive = true
        logo.heightAnchor.constraint(equalToConstant: 64).isActive = true
        title.font = .systemFont(ofSize: 32, weight: .semibold)
        title.textColor = .black
        title.alignment = .center
        title.widthAnchor.constraint(equalToConstant: 448).isActive = true
        message.font = .systemFont(ofSize: 15)
        message.textColor = .darkGray
        message.alignment = .center
        message.maximumNumberOfLines = 4
        message.widthAnchor.constraint(equalToConstant: 448).isActive = true
        progress.font = .systemFont(ofSize: 12, weight: .medium)
        progress.textColor = .darkGray
        action.bezelStyle = .rounded
        action.controlSize = .large
        action.font = .systemFont(ofSize: 16, weight: .semibold)
        action.widthAnchor.constraint(equalToConstant: 228).isActive = true
        // Let AppKit pair the native bezel and label colours in every window state.
        // contentTintColor only applies to borderless buttons.
        action.target = self
        action.action = #selector(install)
        action.keyEquivalent = "\r"
        help.isBordered = false
        help.font = .systemFont(ofSize: 13)
        help.contentTintColor = .darkGray
        help.target = self
        help.action = #selector(showHelp)
        let reassurance = NSTextField(labelWithString: "Your existing searches and saved finds stay in place.")
        reassurance.font = .systemFont(ofSize: 12)
        reassurance.textColor = .darkGray
        let stack = NSStackView(views: [logo, title, message, progress, action, reassurance, help])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 20
        stack.setCustomSpacing(10, after: action)
        stack.setCustomSpacing(8, after: reassurance)
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: content.centerXAnchor), stack.centerYAnchor.constraint(equalTo: content.centerYAnchor)])
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func install() {
        if finished { openChatGPT(); return }
        do {
            let payload = Bundle.main.resourceURL!.appendingPathComponent("plugin")
            if !previewOnly {
                _ = try GoodfindsInstall.install(payload: payload, home: FileManager.default.homeDirectoryForCurrentUser)
            }
            finished = true
            title.stringValue = "One last step\nin ChatGPT."
            message.stringValue = "Choose Install on the Goodfinds page.\nThen tell your agent what you’re looking for."
            progress.stringValue = "✓  Ready on your Mac     →     2  Enable in ChatGPT"
            action.title = "Open ChatGPT"
            openChatGPT()
        } catch {
            message.stringValue = error.localizedDescription
            action.title = "Try again"
        }
    }

    func openChatGPT() {
        guard !previewOnly else { return }
        let url = GoodfindsInstall.pluginURL(home: FileManager.default.homeDirectoryForCurrentUser)
        if !NSWorkspace.shared.open(url) {
            message.stringValue = "Open or update ChatGPT desktop, then try again.\nGoodfinds is ready on your Mac."
            showHelp()
        }
    }

    @objc func showHelp() {
        let alert = NSAlert()
        alert.messageText = "Finish setting up in ChatGPT"
        alert.informativeText = "You need the ChatGPT desktop app with plugin support. If the Goodfinds page does not appear, restart ChatGPT and click Open ChatGPT again.\n\nYou can also open Plugins, choose your personal source (My plugins for a new setup), and select Goodfinds. If Goodfinds is already enabled, you’re ready to use it.\n\nOnce you’re finished, close this setup window."
        alert.addButton(withTitle: "Got it")
        alert.beginSheetModal(for: window)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--install-home" {
    do {
        guard getuid() != 0 else {
            throw InstallError.invalid("Install Goodfinds for your own user account, without sudo.")
        }
        let home = URL(fileURLWithPath: CommandLine.arguments[2])
        _ = try GoodfindsInstall.install(payload: Bundle.main.resourceURL!.appendingPathComponent("plugin"), home: home)
        print(GoodfindsInstall.pluginURL(home: home).absoluteString)
    } catch {
        FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
        exit(1)
    }
} else if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--link-home" {
    print(GoodfindsInstall.pluginURL(home: URL(fileURLWithPath: CommandLine.arguments[2])).absoluteString)
} else if CommandLine.arguments.count == 5 && CommandLine.arguments[1] == "--test-home" && CommandLine.arguments[3] == "--payload" {
    do {
        let destination = try GoodfindsInstall.install(payload: URL(fileURLWithPath: CommandLine.arguments[4]), home: URL(fileURLWithPath: CommandLine.arguments[2]))
        print(destination.path)
    } catch {
        FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
        exit(1)
    }
} else {
    MainActor.assumeIsolated {
        let application = NSApplication.shared
        let delegate = InstallerApp()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
    }
}
