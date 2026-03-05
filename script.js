function showform(formId) {
    document.querySelectorAll(".form-box").forEach(form => form.classList.remove("active"));
    document.getElementById(formId).classList.add("active");
}
if(currentMinutes === medMinutes){
    playSound();  // removed "as"
    alert("💊 Time to take: " + medName);
    showNotification = true;
}