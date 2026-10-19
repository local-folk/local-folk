/* The one place an archive image filename is worked out.
 *
 * Both the renderer and the caption builder need this name, and they MUST
 * arrive at the same string. That was not true until 19 October 2026, when a
 * rebuilt post pointed at an image that was never written and the whole
 * publish failed.
 *
 * What happened, for the record:
 *
 *   generate-social-images.js wrote the file using this rule -
 *     dateLabel.replace(/[^0-9A-Za-z]/g, '')     dashes REMOVED
 *     -> social/archive/Weekly-191026ryjwog.png
 *
 *   build-captions.js wrote ImageVariant using its own slug() helper -
 *     replace(/[^a-z0-9]+/g, '-')                 dash KEPT as a dash
 *     -> ImageVariant = "Weekly-191026-ryjwog"
 *
 * The two only agree while dateLabel contains no dash. A normal post's
 * dateLabel is "191026" and they match. apply-choices.js gives a REBUILT post
 * a dateLabel of "191026-r<stamp>", which contains a dash - and from that
 * moment on, ImageVariant named a file that does not exist.
 *
 * The consequences, all of them silent or misleading:
 *   - the approval email showed no image, because its <img> src 404'd;
 *   - Facebook rejected the post with "Missing or invalid image file" (324);
 *   - Instagram rejected it with "Only photo or video can be accepted as
 *     media type" (9004).
 *
 * The image itself was rendered, correct and deployed, the whole time.
 *
 * So: do not add a second implementation of this rule. Require it from here.
 */

/* The filename with no extension, e.g. "Weekly-191026" or, for a rebuilt
 * post, "Weekly-191026ryjwog". This is the form written into ImageVariant and
 * into the .png / .jpg URLs. */
function archiveBase(variant, dateLabel) {
  const clean = String(dateLabel == null ? '' : dateLabel).replace(/[^0-9A-Za-z]/g, '');
  return variant + '-' + clean;
}

/* The full PNG filename. */
function archiveName(variant, dateLabel) {
  return archiveBase(variant, dateLabel) + '.png';
}

module.exports = { archiveBase: archiveBase, archiveName: archiveName };