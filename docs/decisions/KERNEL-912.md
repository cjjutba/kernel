# KERNEL-912: a chat opens in place

A chat's transcript is rebuilt on every switch. It used to glide into place because rows far above the end were drawn at a 60px placeholder and measured late, and the view chased each change.

- The saved spot (`chatPlace.ts`) also keeps each row's height. A reopened chat gives its rows those heights as their intrinsic size, so they are measured once, at the size they had.
- A chat opening at its end sets the scroll position to the end before the first paint, then holds it every frame until the height stops changing for 4 frames, or 600ms pass. It stays pinned. A restored spot uses the same loop. Either stops when the reader scrolls.
- The scroller carries `data-opening` meanwhile, and steps lists skip their open and fold motion under it. A list opened by hand later still animates.
- Unchanged: `scrollGlide.ts`, when the view follows the end, Scroll to bottom, the rail jump, sending a message.
