**Kernel passes on an image a teammate shared, by its id and version.**

A Team update line for a shared file names its id: `Shared "Login" v2 (image, .kernel/shared/login.png, id <id>)`. `images` on `create_workspace` and `message_agent` takes `{ shared: id, version }` next to KERNEL-658's `{ path }`, and the cap of three counts both kinds together. Kernel reads its own stored copy of that version through `Sharing.sharedImage`, runs it through `imagePart` (check, downscale, data URL), and the send saves it with `saveAttachments`. Kernel never opens the file.

Only PNG, JPEG, GIF and WebP go. HTML, Markdown and PDF are refused by kind. An SVG is an image to share_file but not one the model reads as a picture, so it is refused the way a non-image attachment is. A file from another room, an unknown id and a version Kernel doesn't have are refused too. Every image is read before anything is created or sent, so one refusal sends nothing.

The receiver gets the version Kernel named, not the newest. Each version is its own copy in `<dataDir>/shared/<id>/v<n>/`, and the part carries its bytes as a data URL, so a later share never changes what was passed on. To pass on v2, Kernel forwards v2. KERNEL-659
