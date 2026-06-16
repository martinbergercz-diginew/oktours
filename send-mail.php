<?php
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit('Method Not Allowed');
}

// ── Anti-spam: honeypot + time-check ────────────────────────────────────
// Bots auto-fill any input field they see, including the hidden "website"
// honeypot. Humans never see it. The _t field is the page-load-to-submit
// elapsed time in ms — anything under 3 seconds is almost certainly a
// scripted submission (real users can't fill the form that fast).
// On either trigger we silently return success so the bot moves on, but
// do NOT send the e-mail. Drops are written to syslog for monitoring.
$hp      = trim($_POST['website'] ?? '');
$elapsed = (int)($_POST['_t'] ?? 0);
if ($hp !== '' || $elapsed < 3000) {
    $hpSafe = substr(preg_replace('/[^\x20-\x7e]/', '?', $hp), 0, 80);
    $ip     = $_SERVER['REMOTE_ADDR'] ?? '?';
    error_log("[send-mail] dropped spam — hp='{$hpSafe}', elapsed={$elapsed}ms, ip={$ip}");
    header('Content-Type: application/json');
    echo json_encode(['success' => true]);
    exit;
}

// Route recipients by form_type. Apartments form (dlouhodobe-pronajmy.html)
// sends a hidden form_type=apartments; everything else uses the default.
$formType = $_POST['form_type'] ?? 'default';
if ($formType === 'apartments') {
    $to      = 'tlaskal@okhotels.cz, trejtnarova@oktours.cz';
    $subject = 'Nový dotaz – Dlouhodobé a krátkodobé pronájmy';
} else {
    $to      = 'chumpitaz@oktours.cz, plasil@oktours.cz';
    $subject = 'Nový dotaz z webu OK-TOURS';
}
$bcc     = 'martinbergercz@gmail.com';

$name    = htmlspecialchars(trim($_POST['name'] ?? ''));
$email   = htmlspecialchars(trim($_POST['email'] ?? ''));
$company = htmlspecialchars(trim($_POST['company'] ?? ''));
$topic   = htmlspecialchars(trim($_POST['topic'] ?? ''));
$message = htmlspecialchars(trim($_POST['message'] ?? ''));

if (!$name || !$email || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Neplatné údaje.']);
    exit;
}

$body  = "Jméno: $name\n";
$body .= "E-mail: $email\n";
if ($company) $body .= "Společnost: $company\n";
if ($topic)   $body .= "Oblast zájmu: $topic\n";
$body .= "\nZpráva:\n$message\n";

$headers  = "From: OK TOURS web <no-reply@oktours.cz>\r\n";
$headers .= "Reply-To: $email\r\n";
$headers .= "Bcc: $bcc\r\n";
$headers .= "Content-Type: text/plain; charset=UTF-8\r\n";

// -f sets the envelope sender (MAIL FROM) to no-reply@oktours.cz so it
// matches the From header and the client's M365 SMTP relay.
$sent = mail($to, $subject, $body, $headers, '-f no-reply@oktours.cz');

header('Content-Type: application/json');
echo json_encode(['success' => $sent]);
