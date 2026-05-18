<?php
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit('Method Not Allowed');
}

$to      = 'chumpitaz@oktours.cz, plasil@oktours.cz';
$bcc     = 'martinbergercz@gmail.com';
$subject = 'Nový dotaz z webu OK TOURS';

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
